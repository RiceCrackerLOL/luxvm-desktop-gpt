# RZER Desktop

RZER is a multi-modal desktop workstation built with React, TypeScript, Vite, and Electron, using OpenRouter for model access.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm run dev` to start the web interface.
4. Run `npm run dev` to launch the Electron desktop app with Vite hot reload.
5. Run `npm run build` to type-check the application, compile the Electron process, build the interface, and package the desktop app.

Add your OpenRouter API key in the application settings. The key is stored in the app's local browser storage; do not commit credentials to this repository.

## Workspaces

- General Chat
- Voice Assistant
- Codex Studio
- Chess Bot
- Image Studio

## Design

The interface uses a warm neutral palette, restrained terracotta accents, subtle borders, and responsive interaction states. Existing workspace behavior and OpenRouter integrations are retained.
