# Load .env if present so FOOTBALL_DATA_API_KEY (and anything else) is in the env
# of every recipe. Lines in .env must be plain KEY=value (no `export`, no quotes,
# no shell expansion).
ifneq (,$(wildcard .env))
include .env
export
endif

PYTHON := .venv/bin/python
PORT   := 8765

.PHONY: help install sync serve clean

help:
	@echo "Targets:"
	@echo "  make install   Create .venv and install Python deps"
	@echo "  make sync      Fetch latest WC results and rewrite data/results.json"
	@echo "  make serve     Run local dev server on http://127.0.0.1:$(PORT)"
	@echo "  make clean     Remove .venv and __pycache__"

install:
	python3 -m venv .venv
	$(PYTHON) -m pip install -q --upgrade pip
	$(PYTHON) -m pip install -q -r requirements.txt

sync:
	@if [ -z "$(FOOTBALL_DATA_API_KEY)" ]; then \
		echo "FOOTBALL_DATA_API_KEY is not set."; \
		echo "Add it to .env (copy .env.example) or export it in your shell."; \
		exit 1; \
	fi
	$(PYTHON) sync.py

serve:
	@echo "Serving at http://127.0.0.1:$(PORT)/ — Ctrl-C to stop"
	$(PYTHON) -m http.server $(PORT) --bind 127.0.0.1

clean:
	rm -rf .venv __pycache__
