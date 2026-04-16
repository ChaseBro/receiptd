package services

import (
	"context"
	"errors"

	"github.com/ChaseBro/receiptd/internal/render"
	"github.com/rs/zerolog"
)

// Render is the service for HTML → PNG rendering. Wraps the chromedp-based
// render package so handlers never touch Chrome directly.
type Render struct {
	dataDir string
	logger  zerolog.Logger
}

// NewRender builds a Render service. dataDir is where rendered PNGs are saved.
func NewRender(dataDir string, logger zerolog.Logger) *Render {
	return &Render{
		dataDir: dataDir,
		logger:  logger.With().Str("component", "services.render").Logger(),
	}
}

// RenderInput is an HTML render request.
type RenderInput struct {
	HTML  string
	Width int // <= 0 uses the default printer width
}

// RenderResult describes a saved render.
type RenderResult struct {
	Path  string
	Bytes int
}

// ErrEmptyHTML is returned when RenderInput.HTML is empty.
var ErrEmptyHTML = errors.New("empty html")

// HTMLToPNG renders the provided HTML and saves the PNG under dataDir/renders.
func (s *Render) HTMLToPNG(ctx context.Context, in RenderInput) (*RenderResult, error) {
	if in.HTML == "" {
		return nil, ErrEmptyHTML
	}
	png, err := render.HTMLToPNG(in.HTML, in.Width)
	if err != nil {
		return nil, err
	}
	path, err := render.SaveRender(s.dataDir, png)
	if err != nil {
		return nil, err
	}
	s.logger.Info().Str("path", path).Int("bytes", len(png)).Msg("render saved")
	return &RenderResult{Path: path, Bytes: len(png)}, nil
}
