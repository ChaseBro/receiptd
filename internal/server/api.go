package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/ChaseBro/receiptd/internal/services"
	"github.com/rs/zerolog"
)

// APIHandler serves the v1 REST API alongside the CloudPRNT handler on the
// same HTTP server. Handlers are thin wrappers over the same daemon methods
// the TCP CLI server uses; business logic will be extracted into a services
// layer in step 2 of the cloud roadmap.
type APIHandler struct {
	daemon *Daemon
	logger zerolog.Logger
}

// NewAPIHandler builds a v1 REST handler.
func NewAPIHandler(daemon *Daemon, logger zerolog.Logger) *APIHandler {
	return &APIHandler{
		daemon: daemon,
		logger: logger.With().Str("component", "api").Logger(),
	}
}

// Register mounts the v1 routes onto mux.
func (h *APIHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/healthz", h.handleHealthz)
	mux.HandleFunc("/v1/jobs", h.handleJobsCollection)
	mux.HandleFunc("/v1/jobs/", h.handleJobByID)
	mux.HandleFunc("/v1/render", h.handleRender)
	mux.HandleFunc("/v1/auth/whoami", h.handleWhoami)
	mux.HandleFunc("/v1/auth/keys", h.handleKeysCollection)
	mux.HandleFunc("/v1/auth/keys/", h.handleKeyByID)
	mux.HandleFunc("/v1/auth/device/code", h.handleDeviceCode)
	mux.HandleFunc("/v1/auth/device/token", h.handleDeviceToken)
	mux.HandleFunc("/v1/auth/device/approve", h.handleDeviceApprove)
}

// --- responses ----------------------------------------------------------

type errorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errorResponse{Error: msg, Code: code})
}

// --- handlers -----------------------------------------------------------

func (h *APIHandler) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only GET")
		return
	}
	pending, processing := h.daemon.queue.CountByStatus()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"pending":    pending,
		"processing": processing,
	})
}

type createJobRequest struct {
	PrinterID string `json:"printerId,omitempty"`
	Content   string `json:"content"`
	ImagePath string `json:"imagePath,omitempty"`
	Staged    bool   `json:"staged,omitempty"`
}

func (h *APIHandler) handleJobsCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, h.daemon.jobs.List(r.Context()))
	case http.MethodPost:
		var req createJobRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_body", fmt.Sprintf("decode body: %v", err))
			return
		}
		job, err := h.daemon.jobs.Create(r.Context(), services.CreateInput{
			PrinterID: req.PrinterID,
			Content:   req.Content,
			ImagePath: req.ImagePath,
			Staged:    req.Staged,
		})
		if err != nil {
			if errors.Is(err, services.ErrEmptyJob) {
				writeError(w, http.StatusBadRequest, "empty_job", err.Error())
				return
			}
			writeError(w, http.StatusInternalServerError, "create_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, job)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only GET or POST")
	}
}

func (h *APIHandler) handleJobByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only GET")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/v1/jobs/")
	if id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusBadRequest, "invalid_id", "malformed job id")
		return
	}
	job := h.daemon.jobs.Get(r.Context(), id)
	if job == nil {
		writeError(w, http.StatusNotFound, "not_found", "job not found")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

type whoamiResponse struct {
	Kind    string   `json:"kind"`
	Subject string   `json:"subject"`
	Scopes  []string `json:"scopes"`
}

func (h *APIHandler) handleWhoami(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only GET")
		return
	}
	id := IdentityFromContext(r.Context())
	if id == nil {
		// AuthMiddleware always installs an identity; reaching here means the
		// route was mounted outside the middleware.
		writeError(w, http.StatusUnauthorized, "no_identity", "no identity")
		return
	}
	writeJSON(w, http.StatusOK, whoamiResponse{
		Kind:    id.Kind,
		Subject: id.Subject,
		Scopes:  id.Scopes,
	})
}

type createKeyRequest struct {
	Label  string   `json:"label,omitempty"`
	Scopes []string `json:"scopes,omitempty"`
}

type createKeyResponse struct {
	ID     string   `json:"id"`
	Secret string   `json:"secret"` // shown once
	Label  string   `json:"label,omitempty"`
	Scopes []string `json:"scopes,omitempty"`
}

// handleKeysCollection mints or lists API keys for the caller's subject.
// Requires admin scope today — real policy will arrive with step 6 (users/orgs).
func (h *APIHandler) handleKeysCollection(w http.ResponseWriter, r *http.Request) {
	id := IdentityFromContext(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "no_identity", "no identity")
		return
	}
	if !id.HasScope("admin") {
		writeError(w, http.StatusForbidden, "forbidden", "admin scope required")
		return
	}
	subject := id.Subject
	if id.Kind == "loopback" {
		// Loopback callers act as a default single-tenant user until step 6
		// introduces a real users table.
		subject = "local"
	}

	switch r.Method {
	case http.MethodGet:
		list, err := h.daemon.apiKeys.List(r.Context(), subject)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "list_failed", err.Error())
			return
		}
		// Strip hashes before returning.
		type publicKey struct {
			ID        string   `json:"id"`
			Label     string   `json:"label,omitempty"`
			Scopes    []string `json:"scopes,omitempty"`
			Revoked   bool     `json:"revoked"`
			CreatedAt string   `json:"createdAt"`
		}
		out := make([]publicKey, 0, len(list))
		for _, k := range list {
			out = append(out, publicKey{
				ID:        k.ID,
				Label:     k.Label,
				Scopes:    strings.Fields(k.Scopes),
				Revoked:   k.RevokedAt != nil,
				CreatedAt: k.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			})
		}
		writeJSON(w, http.StatusOK, out)

	case http.MethodPost:
		var req createKeyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_body", fmt.Sprintf("decode body: %v", err))
			return
		}
		minted, err := h.daemon.apiKeys.Mint(r.Context(), services.MintInput{
			Subject: subject,
			Label:   req.Label,
			Scopes:  req.Scopes,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "mint_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, createKeyResponse{
			ID:     minted.Key.ID,
			Secret: minted.Secret,
			Label:  minted.Key.Label,
			Scopes: req.Scopes,
		})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or POST")
	}
}

// --- API key single-resource routes ------------------------------------

func (h *APIHandler) handleKeyByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/auth/keys/")
	if id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusBadRequest, "invalid_id", "malformed key id")
		return
	}
	auth := IdentityFromContext(r.Context())
	if auth == nil || !auth.HasScope("admin") {
		writeError(w, http.StatusForbidden, "forbidden", "admin scope required")
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only DELETE")
		return
	}
	if err := h.daemon.apiKeys.Revoke(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "revoke_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Device flow (RFC 8628) --------------------------------------------

// deviceCodeRequest optionally specifies scopes the device is requesting.
type deviceCodeRequest struct {
	Scopes []string `json:"scopes,omitempty"`
}

type deviceCodeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// POST /v1/auth/device/code — unauthenticated per RFC 8628.
func (h *APIHandler) handleDeviceCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only POST")
		return
	}
	var req deviceCodeRequest
	// Body is optional; ignore decode errors on empty bodies.
	_ = json.NewDecoder(r.Body).Decode(&req)

	result, err := h.daemon.deviceFlow.Start(r.Context(), services.StartInput{Scopes: req.Scopes})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "device_start_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, deviceCodeResponse{
		DeviceCode:              result.DeviceCode,
		UserCode:                result.UserCode,
		VerificationURI:         result.VerificationURI,
		VerificationURIComplete: result.VerificationURIComplete,
		ExpiresIn:               result.ExpiresIn,
		Interval:                result.Interval,
	})
}

type deviceTokenRequest struct {
	DeviceCode string `json:"device_code"`
}

type deviceTokenResponse struct {
	AccessToken string   `json:"access_token"`
	TokenType   string   `json:"token_type"`
	Subject     string   `json:"subject"`
	Scopes      []string `json:"scopes,omitempty"`
}

// POST /v1/auth/device/token — unauthenticated polling endpoint.
// Returns the RFC 8628 error codes as "error" in the body.
func (h *APIHandler) handleDeviceToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only POST")
		return
	}
	var req deviceTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if req.DeviceCode == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "device_code required")
		return
	}
	result, err := h.daemon.deviceFlow.Poll(r.Context(), req.DeviceCode)
	if err != nil {
		switch err {
		case services.ErrAuthorizationPending:
			writeError(w, http.StatusBadRequest, "authorization_pending", "waiting for approval")
		case services.ErrSlowDown:
			writeError(w, http.StatusBadRequest, "slow_down", "slow down")
		case services.ErrExpiredToken:
			writeError(w, http.StatusBadRequest, "expired_token", "device code expired")
		case services.ErrAccessDenied:
			writeError(w, http.StatusBadRequest, "access_denied", "denied")
		default:
			writeError(w, http.StatusBadRequest, "invalid_grant", err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, deviceTokenResponse{
		AccessToken: result.APIKey,
		TokenType:   "Bearer",
		Subject:     result.Subject,
		Scopes:      result.Scopes,
	})
}

type deviceApproveRequest struct {
	UserCode string   `json:"user_code"`
	Scopes   []string `json:"scopes,omitempty"`
	Label    string   `json:"label,omitempty"`
}

// POST /v1/auth/device/approve — authenticated. An admin caller approves a
// pending device flow; the approving caller's subject becomes the minted
// key's owner. Serves as the minimal approval path until step 6 adds a full
// web-UI sign-in flow.
func (h *APIHandler) handleDeviceApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only POST")
		return
	}
	auth := IdentityFromContext(r.Context())
	if auth == nil || !auth.HasScope("admin") {
		writeError(w, http.StatusForbidden, "forbidden", "admin scope required")
		return
	}
	var req deviceApproveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if req.UserCode == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "user_code required")
		return
	}
	subject := auth.Subject
	if auth.Kind == "loopback" {
		subject = "local"
	}
	err := h.daemon.deviceFlow.Approve(r.Context(), services.ApproveInput{
		UserCode: req.UserCode,
		Subject:  subject,
		Scopes:   req.Scopes,
		Label:    req.Label,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "approve_failed", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type renderRequest struct {
	HTML  string `json:"html"`
	Width int    `json:"width,omitempty"`
}

type renderResponse struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
}

func (h *APIHandler) handleRender(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only POST")
		return
	}
	var req renderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", fmt.Sprintf("decode body: %v", err))
		return
	}
	result, err := h.daemon.render.HTMLToPNG(r.Context(), services.RenderInput{
		HTML:  req.HTML,
		Width: req.Width,
	})
	if err != nil {
		if errors.Is(err, services.ErrEmptyHTML) {
			writeError(w, http.StatusBadRequest, "empty_html", err.Error())
			return
		}
		h.logger.Error().Err(err).Msg("render failed")
		writeError(w, http.StatusInternalServerError, "render_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, renderResponse{Path: result.Path, Bytes: result.Bytes})
}
