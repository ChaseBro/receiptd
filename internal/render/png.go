package render

import (
	"encoding/binary"
	"fmt"
	"io"
)

var pngMagic = [8]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// PNGDimensions reads the width and height from a PNG's IHDR chunk.
// It does not decode the full image; it only reads the first 24 bytes.
func PNGDimensions(data []byte) (w, h int, err error) {
	if len(data) < 24 {
		return 0, 0, fmt.Errorf("data too short to be a PNG (%d bytes)", len(data))
	}
	var magic [8]byte
	copy(magic[:], data[:8])
	if magic != pngMagic {
		return 0, 0, fmt.Errorf("not a PNG: bad magic bytes")
	}
	// Bytes 8–11: IHDR chunk length (4 bytes, big-endian)
	// Bytes 12–15: "IHDR" chunk type
	// Bytes 16–19: width (4 bytes, big-endian)
	// Bytes 20–23: height (4 bytes, big-endian)
	if string(data[12:16]) != "IHDR" {
		return 0, 0, fmt.Errorf("expected IHDR chunk, got %q", string(data[12:16]))
	}
	w = int(binary.BigEndian.Uint32(data[16:20]))
	h = int(binary.BigEndian.Uint32(data[20:24]))
	if w <= 0 || h <= 0 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	return w, h, nil
}
