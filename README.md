Magic Event Manager API (NestJS)

- Stack: NestJS (Node 20, TypeScript strict)
- Port: 5001
- Key env vars:
  - `PORT` (default 5001)
  - `TEMPLATES_FILE` (path for file-based template storage; default `data/templates.json`)

Scripts
- `npm run build` – compile to `dist/`
- `npm run start:dev` – dev mode
- `npm run start:prod` – run compiled app

Endpoints (highlights)
- `GET /events` basic in-memory events
- `POST /campaign-templates` CRUD for templates
- `POST /campaign-templates/:id/preview` render preview with JSON variables

Docker
Multi-stage build based on `node:20-alpine`.

