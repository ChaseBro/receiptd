// QR encoder — port of the web app's public/qr.js, which wraps the vendored
// qrcode-generator 1.4.4 (public/vendor/qrcode/qrcode.mjs):
//   Copyright (c) 2009 Kazuhiko Arase, http://www.d-project.com/
//   Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
//   "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
//
// Only what qr.js uses: one 8-bit byte segment, auto type number 1–40, best
// mask by lost point. Output is module-for-module identical to the JS (see
// Tests/BoothCoreTests/QRTests.swift + ios/parity/gen-qr.mjs).
//
// Byte mode matches the JS library's *default* stringToBytes, which is NOT
// UTF-8: each UTF-16 code unit is truncated to its low byte (`c & 0xff`). So
// ASCII is exact, Latin-1 (é) becomes the Latin-1 byte, and anything above
// U+00FF (emoji, ✓) is mangled — exactly as the web booth prints it.

public struct QRMatrix {
    public let n: Int
    let modules: [Bool]  // row-major, n*n

    public func dark(_ row: Int, _ col: Int) -> Bool { modules[row * n + col] }
}

public enum QR {
    /// `level` is "L", "M", "Q" or "H" (anything else is treated as "M").
    /// Traps if the text exceeds version-40 capacity, like the JS throws.
    public static func matrix(_ text: String, level: Character = "M") -> QRMatrix {
        let bytes = text.utf16.map { UInt8(truncatingIfNeeded: $0) }
        return Encoder(bytes: bytes, level: ECLevel(level)).make()
    }

    /// Side length in px of the drawn code: `(n + 2*quiet) * module`.
    public static func side(_ text: String, module: Int = 5, quiet: Int = 4) -> Int {
        (matrix(text).n + 2 * quiet) * module
    }
}

// MARK: - Encoder

private enum ECLevel: Int {
    // Values are the format-info bits (and the JS enum): L=1, M=0, Q=3, H=2.
    case L = 1, M = 0, Q = 3, H = 2

    init(_ c: Character) {
        switch c {
        case "L", "l": self = .L
        case "Q", "q": self = .Q
        case "H", "h": self = .H
        default: self = .M
        }
    }

    /// Row offset in RS_BLOCK_TABLE (L, M, Q, H order).
    var tableOffset: Int {
        switch self { case .L: 0; case .M: 1; case .Q: 2; case .H: 3 }
    }
}

private struct Encoder {
    let bytes: [UInt8]
    let level: ECLevel

    private static let modeByte = 1 << 2

    func make() -> QRMatrix {
        var typeNumber = 1
        while typeNumber < 40 {
            if dataBitLength(typeNumber) <= totalDataCount(typeNumber) * 8 { break }
            typeNumber += 1
        }
        let data = createData(typeNumber)

        var best = 0
        var minLost = 0.0
        for mask in 0..<8 {
            let m = Matrix(typeNumber: typeNumber, level: level, test: true, mask: mask, data: data)
            let lost = m.lostPoint()
            if mask == 0 || minLost > lost {
                minLost = lost
                best = mask
            }
        }
        let m = Matrix(typeNumber: typeNumber, level: level, test: false, mask: best, data: data)
        return QRMatrix(n: m.n, modules: m.cells.map { $0 == 1 })
    }

    private func lengthBits(_ typeNumber: Int) -> Int { typeNumber < 10 ? 8 : 16 }

    private func dataBitLength(_ typeNumber: Int) -> Int {
        4 + lengthBits(typeNumber) + bytes.count * 8
    }

    private func totalDataCount(_ typeNumber: Int) -> Int {
        RS.blocks(typeNumber, level).reduce(0) { $0 + $1.data }
    }

    private func createData(_ typeNumber: Int) -> [Int] {
        let blocks = RS.blocks(typeNumber, level)
        var buf = BitBuffer()
        buf.put(Encoder.modeByte, 4)
        buf.put(bytes.count, lengthBits(typeNumber))
        for b in bytes { buf.put(Int(b), 8) }

        let totalBits = blocks.reduce(0) { $0 + $1.data } * 8
        precondition(buf.length <= totalBits, "QR: code length overflow (\(buf.length)>\(totalBits))")

        if buf.length + 4 <= totalBits { buf.put(0, 4) }
        while buf.length % 8 != 0 { buf.putBit(false) }
        while true {
            if buf.length >= totalBits { break }
            buf.put(0xEC, 8)
            if buf.length >= totalBits { break }
            buf.put(0x11, 8)
        }
        return createBytes(buf.buffer, blocks)
    }

    private func createBytes(_ buffer: [Int], _ blocks: [(total: Int, data: Int)]) -> [Int] {
        var offset = 0
        var maxDc = 0, maxEc = 0
        var dcdata: [[Int]] = []
        var ecdata: [[Int]] = []

        for b in blocks {
            let dcCount = b.data, ecCount = b.total - b.data
            maxDc = max(maxDc, dcCount)
            maxEc = max(maxEc, ecCount)
            let dc = (0..<dcCount).map { 0xff & buffer[$0 + offset] }
            offset += dcCount
            dcdata.append(dc)
            ecdata.append(GF.remainder(dc, ecCount))
        }

        var out: [Int] = []
        out.reserveCapacity(blocks.reduce(0) { $0 + $1.total })
        for i in 0..<maxDc { for r in dcdata.indices where i < dcdata[r].count { out.append(dcdata[r][i]) } }
        for i in 0..<maxEc { for r in ecdata.indices where i < ecdata[r].count { out.append(ecdata[r][i]) } }
        return out
    }
}

private struct BitBuffer {
    var buffer: [Int] = []
    var length = 0

    mutating func put(_ num: Int, _ len: Int) {
        for i in 0..<len { putBit(((num >> (len - i - 1)) & 1) == 1) }
    }

    mutating func putBit(_ bit: Bool) {
        let idx = length / 8
        if buffer.count <= idx { buffer.append(0) }
        if bit { buffer[idx] |= (0x80 >> (length % 8)) }
        length += 1
    }
}

// MARK: - Module placement

private struct Matrix {
    let n: Int
    /// -1 = unset, 0 = light, 1 = dark.
    var cells: [Int8]

    init(typeNumber: Int, level: ECLevel, test: Bool, mask: Int, data: [Int]) {
        n = typeNumber * 4 + 17
        cells = Array(repeating: -1, count: n * n)
        probe(0, 0)
        probe(n - 7, 0)
        probe(0, n - 7)
        adjust(typeNumber)
        timing()
        typeInfo(level: level, test: test, mask: mask)
        if typeNumber >= 7 { typeNumberBits(typeNumber, test: test) }
        mapData(data, mask: mask)
    }

    subscript(r: Int, c: Int) -> Int8 {
        get { cells[r * n + c] }
        set { cells[r * n + c] = newValue }
    }

    func isDark(_ r: Int, _ c: Int) -> Bool { cells[r * n + c] == 1 }

    private mutating func set(_ r: Int, _ c: Int, _ v: Bool) { self[r, c] = v ? 1 : 0 }

    private mutating func probe(_ row: Int, _ col: Int) {
        for r in -1...7 {
            if row + r <= -1 || n <= row + r { continue }
            for c in -1...7 {
                if col + c <= -1 || n <= col + c { continue }
                let on = (0 <= r && r <= 6 && (c == 0 || c == 6))
                    || (0 <= c && c <= 6 && (r == 0 || r == 6))
                    || (2 <= r && r <= 4 && 2 <= c && c <= 4)
                set(row + r, col + c, on)
            }
        }
    }

    private mutating func timing() {
        if n - 8 > 8 {
            for r in 8..<(n - 8) where self[r, 6] == -1 { set(r, 6, r % 2 == 0) }
            for c in 8..<(n - 8) where self[6, c] == -1 { set(6, c, c % 2 == 0) }
        }
    }

    private mutating func adjust(_ typeNumber: Int) {
        let pos = QRTables.patternPosition[typeNumber - 1]
        for row in pos {
            for col in pos {
                if self[row, col] != -1 { continue }
                for r in -2...2 {
                    for c in -2...2 {
                        set(row + r, col + c, r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0))
                    }
                }
            }
        }
    }

    private mutating func typeNumberBits(_ typeNumber: Int, test: Bool) {
        let bits = BCH.typeNumber(typeNumber)
        for i in 0..<18 {
            let mod = !test && ((bits >> i) & 1) == 1
            set(i / 3, i % 3 + n - 8 - 3, mod)
        }
        for i in 0..<18 {
            let mod = !test && ((bits >> i) & 1) == 1
            set(i % 3 + n - 8 - 3, i / 3, mod)
        }
    }

    private mutating func typeInfo(level: ECLevel, test: Bool, mask: Int) {
        let bits = BCH.typeInfo((level.rawValue << 3) | mask)
        for i in 0..<15 {
            let mod = !test && ((bits >> i) & 1) == 1
            if i < 6 { set(i, 8, mod) }
            else if i < 8 { set(i + 1, 8, mod) }
            else { set(n - 15 + i, 8, mod) }
        }
        for i in 0..<15 {
            let mod = !test && ((bits >> i) & 1) == 1
            if i < 8 { set(8, n - i - 1, mod) }
            else if i < 9 { set(8, 15 - i - 1 + 1, mod) }
            else { set(8, 15 - i - 1, mod) }
        }
        set(n - 8, 8, !test)
    }

    private mutating func mapData(_ data: [Int], mask: Int) {
        var inc = -1
        var row = n - 1
        var bitIndex = 7
        var byteIndex = 0
        var col = n - 1
        while col > 0 {
            if col == 6 { col -= 1 }
            while true {
                for c in 0..<2 where self[row, col - c] == -1 {
                    var dark = false
                    if byteIndex < data.count { dark = ((data[byteIndex] >> bitIndex) & 1) == 1 }
                    if Matrix.mask(mask, row, col - c) { dark.toggle() }
                    set(row, col - c, dark)
                    bitIndex -= 1
                    if bitIndex == -1 {
                        byteIndex += 1
                        bitIndex = 7
                    }
                }
                row += inc
                if row < 0 || n <= row {
                    row -= inc
                    inc = -inc
                    break
                }
            }
            col -= 2
        }
    }

    private static func mask(_ p: Int, _ i: Int, _ j: Int) -> Bool {
        switch p {
        case 0: return (i + j) % 2 == 0
        case 1: return i % 2 == 0
        case 2: return j % 3 == 0
        case 3: return (i + j) % 3 == 0
        case 4: return (i / 2 + j / 3) % 2 == 0
        case 5: return (i * j) % 2 + (i * j) % 3 == 0
        case 6: return ((i * j) % 2 + (i * j) % 3) % 2 == 0
        default: return ((i * j) % 3 + (i + j) % 2) % 2 == 0
        }
    }

    /// QRUtil.getLostPoint. Returns a Double because the JS's dark-ratio term
    /// is fractional; the arithmetic mirrors it so mask ties break the same way.
    func lostPoint() -> Double {
        var lost = 0

        // Level 1: same-colour neighbours.
        for row in 0..<n {
            for col in 0..<n {
                var same = 0
                let d = isDark(row, col)
                for r in -1...1 {
                    if row + r < 0 || n <= row + r { continue }
                    for c in -1...1 {
                        if col + c < 0 || n <= col + c { continue }
                        if r == 0 && c == 0 { continue }
                        if d == isDark(row + r, col + c) { same += 1 }
                    }
                }
                if same > 5 { lost += 3 + same - 5 }
            }
        }

        // Level 2: 2x2 blocks.
        for row in 0..<(n - 1) {
            for col in 0..<(n - 1) {
                var count = 0
                if isDark(row, col) { count += 1 }
                if isDark(row + 1, col) { count += 1 }
                if isDark(row, col + 1) { count += 1 }
                if isDark(row + 1, col + 1) { count += 1 }
                if count == 0 || count == 4 { lost += 3 }
            }
        }

        // Level 3: 1:1:3:1:1 finder-like runs.
        for row in 0..<n {
            for col in 0..<(n - 6) {
                if isDark(row, col) && !isDark(row, col + 1) && isDark(row, col + 2) && isDark(row, col + 3)
                    && isDark(row, col + 4) && !isDark(row, col + 5) && isDark(row, col + 6) { lost += 40 }
            }
        }
        for col in 0..<n {
            for row in 0..<(n - 6) {
                if isDark(row, col) && !isDark(row + 1, col) && isDark(row + 2, col) && isDark(row + 3, col)
                    && isDark(row + 4, col) && !isDark(row + 5, col) && isDark(row + 6, col) { lost += 40 }
            }
        }

        // Level 4: dark ratio. JS: Math.abs(100 * darkCount / n / n - 50) / 5 * 10
        var darkCount = 0
        for v in cells where v == 1 { darkCount += 1 }
        let nn = Double(n)
        let ratio = abs(100.0 * Double(darkCount) / nn / nn - 50.0) / 5.0
        return Double(lost) + ratio * 10.0
    }
}

// MARK: - BCH, Galois field, RS blocks

private enum BCH {
    static let g15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0)
    static let g18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0)
    static let g15Mask = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)

    static func digit(_ d: Int) -> Int {
        var data = d, digit = 0
        while data != 0 { digit += 1; data >>= 1 }
        return digit
    }

    static func typeInfo(_ data: Int) -> Int {
        var d = data << 10
        while digit(d) - digit(g15) >= 0 { d ^= g15 << (digit(d) - digit(g15)) }
        return ((data << 10) | d) ^ g15Mask
    }

    static func typeNumber(_ data: Int) -> Int {
        var d = data << 12
        while digit(d) - digit(g18) >= 0 { d ^= g18 << (digit(d) - digit(g18)) }
        return (data << 12) | d
    }
}

private enum GF {
    static let tables: (exp: [Int], log: [Int]) = {
        var exp = [Int](repeating: 0, count: 256)
        var log = [Int](repeating: 0, count: 256)
        for i in 0..<8 { exp[i] = 1 << i }
        for i in 8..<256 { exp[i] = exp[i - 4] ^ exp[i - 5] ^ exp[i - 6] ^ exp[i - 8] }
        for i in 0..<255 { log[exp[i]] = i }
        return (exp, log)
    }()

    static func gexp(_ n: Int) -> Int { tables.exp[((n % 255) + 255) % 255] }
    static func glog(_ n: Int) -> Int { precondition(n >= 1); return tables.log[n] }

    /// Generator polynomial of degree `ec`, highest coefficient first (all non-zero).
    static func generator(_ ec: Int) -> [Int] {
        var a = [1]
        for i in 0..<ec {
            let b = [1, gexp(i)]
            var num = [Int](repeating: 0, count: a.count + b.count - 1)
            for x in a.indices { for y in b.indices { num[x + y] ^= gexp(glog(a[x]) + glog(b[y])) } }
            a = num
        }
        return a
    }

    /// EC codewords: (data · x^ec) mod generator, left-padded to `ec` entries.
    /// Same result as the JS qrPolynomial.mod chain (its stray `undefined`
    /// coefficients all behave as 0).
    static func remainder(_ data: [Int], _ ec: Int) -> [Int] {
        let gen = generator(ec)
        var msg = data + [Int](repeating: 0, count: ec)
        for i in 0..<data.count {
            let lead = msg[i]
            if lead == 0 { continue }
            let ratio = glog(lead) - glog(gen[0])
            for j in gen.indices { msg[i + j] ^= gexp(glog(gen[j]) + ratio) }
        }
        return Array(msg[data.count...])
    }
}

private enum RS {
    static func blocks(_ typeNumber: Int, _ level: ECLevel) -> [(total: Int, data: Int)] {
        let row = QRTables.rsBlocks[(typeNumber - 1) * 4 + level.tableOffset]
        var list: [(total: Int, data: Int)] = []
        for i in 0..<(row.count / 3) {
            for _ in 0..<row[i * 3] { list.append((row[i * 3 + 1], row[i * 3 + 2])) }
        }
        return list
    }
}

private enum QRTables {
    static let patternPosition: [[Int]] = [
        [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
        [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
        [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
        [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
        [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
        [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
        [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
        [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
        [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
    ]

    /// [count, total, data, (count, total, data)] per version × (L, M, Q, H).
    static let rsBlocks: [[Int]] = [
        // 1
        [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
        // 2
        [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
        // 3
        [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
        // 4
        [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
        // 5
        [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
        // 6
        [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
        // 7
        [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
        // 8
        [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
        // 9
        [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
        // 10
        [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16],
        // 11
        [4, 101, 81], [1, 80, 50, 4, 81, 51], [4, 50, 22, 4, 51, 23], [3, 36, 12, 8, 37, 13],
        // 12
        [2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37], [4, 46, 20, 6, 47, 21], [7, 42, 14, 4, 43, 15],
        // 13
        [4, 133, 107], [8, 59, 37, 1, 60, 38], [8, 44, 20, 4, 45, 21], [12, 33, 11, 4, 34, 12],
        // 14
        [3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41], [11, 36, 16, 5, 37, 17], [11, 36, 12, 5, 37, 13],
        // 15
        [5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42], [5, 54, 24, 7, 55, 25], [11, 36, 12, 7, 37, 13],
        // 16
        [5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46], [15, 43, 19, 2, 44, 20], [3, 45, 15, 13, 46, 16],
        // 17
        [1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47], [1, 50, 22, 15, 51, 23], [2, 42, 14, 17, 43, 15],
        // 18
        [5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44], [17, 50, 22, 1, 51, 23], [2, 42, 14, 19, 43, 15],
        // 19
        [3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45], [17, 47, 21, 4, 48, 22], [9, 39, 13, 16, 40, 14],
        // 20
        [3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42], [15, 54, 24, 5, 55, 25], [15, 43, 15, 10, 44, 16],
        // 21
        [4, 144, 116, 4, 145, 117], [17, 68, 42], [17, 50, 22, 6, 51, 23], [19, 46, 16, 6, 47, 17],
        // 22
        [2, 139, 111, 7, 140, 112], [17, 74, 46], [7, 54, 24, 16, 55, 25], [34, 37, 13],
        // 23
        [4, 151, 121, 5, 152, 122], [4, 75, 47, 14, 76, 48], [11, 54, 24, 14, 55, 25], [16, 45, 15, 14, 46, 16],
        // 24
        [6, 147, 117, 4, 148, 118], [6, 73, 45, 14, 74, 46], [11, 54, 24, 16, 55, 25], [30, 46, 16, 2, 47, 17],
        // 25
        [8, 132, 106, 4, 133, 107], [8, 75, 47, 13, 76, 48], [7, 54, 24, 22, 55, 25], [22, 45, 15, 13, 46, 16],
        // 26
        [10, 142, 114, 2, 143, 115], [19, 74, 46, 4, 75, 47], [28, 50, 22, 6, 51, 23], [33, 46, 16, 4, 47, 17],
        // 27
        [8, 152, 122, 4, 153, 123], [22, 73, 45, 3, 74, 46], [8, 53, 23, 26, 54, 24], [12, 45, 15, 28, 46, 16],
        // 28
        [3, 147, 117, 10, 148, 118], [3, 73, 45, 23, 74, 46], [4, 54, 24, 31, 55, 25], [11, 45, 15, 31, 46, 16],
        // 29
        [7, 146, 116, 7, 147, 117], [21, 73, 45, 7, 74, 46], [1, 53, 23, 37, 54, 24], [19, 45, 15, 26, 46, 16],
        // 30
        [5, 145, 115, 10, 146, 116], [19, 75, 47, 10, 76, 48], [15, 54, 24, 25, 55, 25], [23, 45, 15, 25, 46, 16],
        // 31
        [13, 145, 115, 3, 146, 116], [2, 74, 46, 29, 75, 47], [42, 54, 24, 1, 55, 25], [23, 45, 15, 28, 46, 16],
        // 32
        [17, 145, 115], [10, 74, 46, 23, 75, 47], [10, 54, 24, 35, 55, 25], [19, 45, 15, 35, 46, 16],
        // 33
        [17, 145, 115, 1, 146, 116], [14, 74, 46, 21, 75, 47], [29, 54, 24, 19, 55, 25], [11, 45, 15, 46, 46, 16],
        // 34
        [13, 145, 115, 6, 146, 116], [14, 74, 46, 23, 75, 47], [44, 54, 24, 7, 55, 25], [59, 46, 16, 1, 47, 17],
        // 35
        [12, 151, 121, 7, 152, 122], [12, 75, 47, 26, 76, 48], [39, 54, 24, 14, 55, 25], [22, 45, 15, 41, 46, 16],
        // 36
        [6, 151, 121, 14, 152, 122], [6, 75, 47, 34, 76, 48], [46, 54, 24, 10, 55, 25], [2, 45, 15, 64, 46, 16],
        // 37
        [17, 152, 122, 4, 153, 123], [29, 74, 46, 14, 75, 47], [49, 54, 24, 10, 55, 25], [24, 45, 15, 46, 46, 16],
        // 38
        [4, 152, 122, 18, 153, 123], [13, 74, 46, 32, 75, 47], [48, 54, 24, 14, 55, 25], [42, 45, 15, 32, 46, 16],
        // 39
        [20, 147, 117, 4, 148, 118], [40, 75, 47, 7, 76, 48], [43, 54, 24, 22, 55, 25], [10, 45, 15, 67, 46, 16],
        // 40
        [19, 148, 118, 6, 149, 119], [18, 75, 47, 31, 76, 48], [34, 54, 24, 34, 55, 25], [20, 45, 15, 61, 46, 16],
    ]
}
