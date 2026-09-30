package chat

import (
	"crypto/rand"
	"encoding/base64"
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
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	encoded := make([]byte, 10)
	for index := range encoded {
		for {
			var value [1]byte
			if _, err := io.ReadFull(rand.Reader, value[:]); err != nil {
				return "", err
			}
			if value[0] < 252 { // 252 is divisible by len(alphabet).
				encoded[index] = alphabet[int(value[0])%len(alphabet)]
				break
			}
		}
	}
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
