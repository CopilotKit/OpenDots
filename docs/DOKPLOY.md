# Deploy OpenDots with Dokploy

OpenDots includes `compose.dokploy.yml` for a single-owner Dokploy deployment.
It builds the **app** Docker stage, serves port **4310**, and persists pages and
workspace settings in the `opendots-data` named volume. Dokploy routes your HTTPS
domain to the container; there is no host port mapping to configure.

## First deployment

1. In your Dokploy project, create a **Docker Compose** service. Choose Compose,
   not Docker Stack: this configuration builds from source.
2. Choose GitHub as the source, select your OpenDots repository and branch,
   and set Compose path **compose.dokploy.yml**. If your connected GitHub source
   limits repository access, include your repository in its allowed repositories.
3. In **Environment**, paste `deployment/dokploy.env.example`. Replace
   `APP_ORIGIN` with your exact public origin, such as `https://dots.example.com`,
   without a path or trailing slash. Replace `OWNER_TOKEN` with a random secret
   of at least 24 characters; it is the token you use to unlock the app.
   Generate one locally with:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. Point the domain's DNS record to your server. In Dokploy's **Domains** tab,
   add that same hostname, select service **app**, container port **4310**,
   path **/**, and enable HTTPS with Let's Encrypt. Use **Preview Compose**
   to inspect Dokploy's generated routing settings.
5. Click **Deploy**. Open the domain and enter your `OWNER_TOKEN`. Until AI
   credentials are supplied, Spaces, pages and Dot preferences work in setup mode.

After this initial configuration, use **Deploy** for subsequent deployments.
You can enable Dokploy Auto Deploy if you want pushes to trigger deployment.

## Enable AI chat

In your local OpenDots folder, run:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select
```

The CLI writes `CPK_INTELLIGENCE_API_KEY` and its `CPK_TELEMETRY_ID` to your local
`.env`. Copy those values into Dokploy's **Environment** tab, then add
`OPENAI_API_KEY` and `OPENAI_MODEL` for your chosen model provider. Save and deploy
again. Keep secrets in Dokploy's environment settings; never commit `.env`.
Do not run `copilotkit onboard`: OpenDots already includes the integration.

Chat stores its conversation history in CopilotKit Intelligence. The named volume
stores pages, workspace configuration and thread bindings. Back up both layers;
keep the Dokploy service/project name stable to retain its volume, and do not
delete that volume when updating the application.

Voice, Slack and per-Dot computers need their own service configuration. See
`docs/SETUP.md` and `docs/COMPUTERS.md`. This deployment uses the default Parallel
research provider; the optional browser worker is not part of this Compose file.

## Verification and references

Successful startup logs include `OpenDots template listening on http://0.0.0.0:4310`.
The container health check verifies the web server responds; confirm AI chat
separately after configuring its credentials.

- [Dokploy Docker Compose](https://docs.dokploy.com/docs/core/docker-compose)
- [Dokploy Compose domain routing](https://docs.dokploy.com/docs/core/docker-compose/domains)

Deployment and connected AI responses require your Dokploy configuration and
account credentials. Verify chat separately from the container health check.
