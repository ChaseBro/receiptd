// swift-tools-version: 6.0
// BoothCore: the booth's logic with no UI — strip layout + print art (port of
// public/frames.js), the raster pipeline (public/raster.js), QR, the booth API
// client and the archive queue. `swift test` runs on the Mac against fixtures
// rendered by the web app (see ../parity).
import PackageDescription

let package = Package(
    name: "BoothCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "BoothCore", targets: ["BoothCore"])],
    targets: [
        // Optimized even in Debug: the dither is a tight per-pixel loop that
        // takes seconds unoptimized (kiosk testing from Xcode would drag).
        .target(name: "BoothCore", resources: [.copy("Resources")],
                swiftSettings: [.swiftLanguageMode(.v5), .unsafeFlags(["-O"], .when(configuration: .debug))]),
        .testTarget(name: "BoothCoreTests", dependencies: ["BoothCore"],
                    resources: [.copy("Fixtures")],
                    swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
