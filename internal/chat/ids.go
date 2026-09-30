package chat

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"io"
)

func randomID() (string, error) {
	bytes := make([]byte, 18)
	if _, err := io.ReadFull(rand.Reader, bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func newAnonID() (string, error) {
	result := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, result); err != nil {
		return "", err
	}
	result[6] = (result[6] & 0x0f) | 0x40
	result[8] = (result[8] & 0x3f) | 0x80
	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], result[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], result[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], result[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], result[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], result[10:16])
	return "anon-" + string(encoded), nil
}

func newOwnerCapability() ([]byte, error) {
	bytes := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, bytes); err != nil {
		return nil, err
	}
	return bytes, nil
}

func encodeCapability(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeCapability(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(value)
}
