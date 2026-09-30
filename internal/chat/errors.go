package chat

import "net/http"

type APIError struct {
	Status int
	Code   string
}

func (e *APIError) Error() string { return e.Code }

func apiError(status int, code string) *APIError {
	return &APIError{Status: status, Code: code}
}

var (
	errInvalidAnonID  = apiError(http.StatusBadRequest, "invalid_anon_id")
	errInvalidPayload = apiError(http.StatusBadRequest, "invalid_payload")
	errRoomNotFound   = apiError(http.StatusNotFound, "room_not_found")
	errRoomClosed     = apiError(http.StatusGone, "room_closed")
	errForbidden      = apiError(http.StatusForbidden, "forbidden")
	errOverloaded     = apiError(http.StatusServiceUnavailable, "overloaded")
	errUnavailable    = apiError(http.StatusServiceUnavailable, "unavailable")
)
