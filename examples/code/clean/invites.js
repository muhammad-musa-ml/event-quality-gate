import { analytics } from './tracker.js';

export function sendInvites(workspaceId, emails, role) {
  analytics.track('invite_sent', {
    workspace_id: workspaceId,
    invitee_count: emails.length,
    role,
    bulk: emails.length > 1,
  });
}

export function createDemoPage() {
  analytics.track("page_created", { workspace_id: "ws_demo", template: "wiki" });
}
