import { analytics, track } from './tracker';

export function onEmailSignup(referrer: string): void {
  analytics.track('signup_completed', { method: 'email', referrer });
}

export function onSsoSignup(): void {
  track('signup_completed', { method: 'sso' });
}

export function onWorkspaceCreated(workspaceId: string, seats: number): void {
  track('workspace_created', {
    workspace_id: workspaceId,
    plan_tier: 'free',
    seats,
  });
}

export function onFirstPage(workspaceId: string, blocks: number): void {
  analytics.track('page_created', {
    workspace_id: workspaceId,
    template: 'blank',
    source: 'onboarding',
    block_count: blocks,
  });
}
