# A computer for each Dot

OpenDots connects each specialist to its own container through [OpenBot](https://github.com/CopilotKit/OpenBot)'s computer service and supervisor. A Dot's ID determines its computer and persistent volumes. Files and browser profiles survive stop/start; they are separate from Spaces pages and CopilotKit conversation history.

The app exposes selected computer tools to the same Dot agent used by web chat, Slack, scheduled work, and voice's compute delegation. Browser, workspace-file, and shell permissions are saved per Dot and checked by the server. They start disabled. No action falls back to your host's shell or files when the computer service is unavailable.

## Start services for local development

Use a working Docker Engine with Compose v2 and BuildKit support for additional build contexts. Keep the application on Node.js 24 as described in [Setup](SETUP.md). Add two different random secrets of at least 24 characters to `.env` and set:

```dotenv
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
COMPUTER_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
COMPUTER_NAMESPACE=opendots
```

Do not use the placeholder values. The supervisor token authorizes lifecycle requests. The computer token is a master used to derive a different credential for each Dot; the master stays in the application and supervisor.

Build both images before starting the supervisor:

```sh
docker compose -f compose.computers.yml build computer-image computer-supervisor
docker compose -f compose.computers.yml up -d computer-supervisor
npm run dev
```

The computer-image service is a build target, not a shared computer to run. The supervisor creates a container when you start a Dot's computer. In this local arrangement, each computer publishes a dynamic loopback port for the app to reach. Port 4312 is the loopback supervisor endpoint. The local control network uses a normal bridge so Docker can publish that port. The container-app overlay makes the control network internal and removes the host port; the app then connects through service DNS.

Open a Dot's **Computer** panel, enable computer access and the capabilities you want, then choose **Start**. Check its status, navigate to a page, and refresh its screen. Only grant shell access when that Dot needs to run commands.

## Run the application in containers

Configure the existing `OWNER_TOKEN` and `BROWSER_SECRET` as well as the computer secrets. Use the overlay that connects the app to the supervisor and computer network:

```sh
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml build computer-image computer-supervisor app browser
docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml up -d app browser computer-supervisor
```

Here, the app addresses computers by their container names. Computers have no published host ports. The supervisor lives on a separate control network, and only the supervisor mounts the Docker socket. Neither the web app nor a Dot's computer receives that socket. Changing the namespace changes which containers and volumes are selected; keep it stable and unique for each deployment.

## Use the computer

- **Browser:** navigate and inspect the current page, including screenshots and element snapshots. Browser profiles keep cookies and logins across container restarts.
- **Take control:** pause agent input while you click, type, scroll, or press keys in the browser. Release control when done. The agent must obtain a fresh snapshot before resuming element actions.
- **Files:** list, read, and write text files in the Dot's workspace. Paths must stay relative to that workspace. These files are not automatically added to Spaces pages.
- **Terminal:** run a bounded command inside that Dot's container when shell access is enabled. Command output is displayed; execution does not run on the OpenDots host.
- **Activity:** inspect action names, who requested them, and success/failure. The audit record deliberately excludes typed values, file contents, and full commands.

Stop retains files and browser profiles. The app does not expose a destructive reset action. Stopping the supervisor does not stop its dynamically created computers; stop each Dot's computer first if you want them all offline. Compose does not own those dynamically created containers or volumes. Do not delete named workspace/profile volumes as routine cleanup.

Revoking a capability cancels the application's active request and prevents subsequent actions. Cancellation cannot undo completed side effects, and an upstream browser operation may finish after the request is cancelled. Stop the computer when you need to end all activity in its container. Activity retains the latest 1,000 completed records per Dot, plus pending requests.

The template uses standard Docker container isolation; containers share the host kernel. Shell access permits programs and network access inside the container and can read that Dot's own browser profile. Run this on infrastructure appropriate for that trust level. `COMPUTER_RUNTIME=runsc` can select an already-installed gVisor runtime; the template does not install it or claim stronger isolation by default. It does not configure a restrictive network-egress policy.

## Verify and troubleshoot

Create two Dots and enable the capabilities being tested. Write a file in the first computer, then verify that the second cannot list it. Stop/start the first and verify the file persists. Test a browser session across a restart, takeover and handback, disabled permissions, and pause behavior. Confirm that computer tools fail clearly if the service is unavailable.

A configured endpoint is not evidence that Docker successfully provisioned a computer. An unavailable status can mean the Docker daemon is down, the image was not built, credentials differ, or the app cannot reach the returned computer address. Use the local arrangement for a host-run app and the app overlay for a container-run app. Do not substitute an arbitrary returned service URL or expose the computer API directly to the internet.

The source revision and the narrow per-Dot credential patch are documented in [deployment/computers](../deployment/computers/README.md). On a master-token or image change, the supervisor replaces owned computer containers on their next ensure request, retaining their profile and workspace volumes. This ends any in-flight activity; coordinate updates with active work.

Automated tests use controlled service fixtures for policy, request, and lifecycle behavior. Live Docker, model, Slack, and voice checks must be recorded separately from those tests.
