import { track } from './tracker';

export function Checklist({ workspaceId }: { workspaceId: string }) {
  return (
    <ul>
      <li onClick={() => track('onboarding_step_completed', { step: 'profile', skipped: false })}>Profile</li>
      <li onClick={() => track('onboarding_step_completed', { step: 'import', skipped: true })}>Import</li>
      <li onClick={() => track('invite_sent', { workspace_id: workspaceId, invitee_count: 3, role: 'member' })}>Invite</li>
    </ul>
  );
}
