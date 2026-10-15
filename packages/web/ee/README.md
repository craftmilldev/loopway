# ee

Code in this directory is under the loopway Enterprise License (`./LICENSE`), not the MIT license that covers the rest of the repo. See the root `LICENSE`.

Server routes go in `routes.ts` (`eeRoutes`), which `src/api.ts` mounts in one place. Client code is under `client/`.

Today it holds requests: `POST /sources/requests` and the dashboard's "Something else…" option, which let a user ask for a webhook source loopway doesn't have, and `POST /harnesses/requests` with the same option on the new-bot form, which asks for an agent harness by its product page URL. Both post to the requests inbox as `source.requested` and `harness.requested`.
