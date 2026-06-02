// CodeKey telemetry plugin for OpenCode
// Installed by CodeKey VS Code extension — copies events to CodeKey bridge
// for sidebar status display. Does NOT participate in approval decisions.
const BRIDGE_URL = 'http://127.0.0.1:3001';

export const CodeKeyTelemetry = async () => {
  return {
    event: async ({ event }) => {
      try {
        await fetch(BRIDGE_URL + '/v1/opencode/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: event.type,
            properties: event.properties,
            ts: new Date().toISOString(),
          }),
        });
      } catch { /* bridge not available */ }
    },
  };
};
