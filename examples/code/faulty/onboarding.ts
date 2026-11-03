import { analytics, track } from './tracker';

// Each fault below is planted on purpose. The comment above it names what `eqg lint-code` should report.

// unknown-event: the name is misspelled
export function onSignup(): void {
  analytics.track('signup_complete', { method: 'email' });
}

// missing-required-property: plan_tier is required
export function onWorkspaceCreated(workspaceId: string): void {
  track('workspace_created', { workspace_id: workspaceId });
}

// unexpected-property: colour is not declared for page_created
export function onPageCreated(workspaceId: string): void {
  track('page_created', { workspace_id: workspaceId, template: 'blank', colour: 'red' });
}

// type-mismatch: seats is an integer in the plan
export function onSeats(workspaceId: string): void {
  track('workspace_created', { workspace_id: workspaceId, plan_tier: 'free', seats: '5' });
}

// enum-violation: role is member or guest
export function onInvite(workspaceId: string): void {
  track('invite_sent', { workspace_id: workspaceId, invitee_count: 2, role: 'admin' });
}

// non-literal-event-name: the tool cannot tell which event this is, so it says so
export function onAnything(eventName: string): void {
  track(eventName, { method: 'email' });
}

// pii-shaped-value: an email address in a property the plan does not mark as pii
export function onReferral(): void {
  analytics.track('signup_completed', { method: 'email', referrer: 'jane.doe@example.com' });
}

// unverifiable-properties: properties passed in a variable cannot be read
export function onStep(props: Record<string, unknown>): void {
  track('onboarding_step_completed', props);
}
