package web

import "embed"

//go:embed dist/*.html dist/*.txt dist/*.webmanifest dist/*.xml dist/*.ico dist/*.svg all:dist/room all:dist/_next/static
var Files embed.FS
