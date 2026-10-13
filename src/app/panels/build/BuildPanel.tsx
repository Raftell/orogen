// The component of the build panel in its starting state (index.ts says what the panel is to become).

import { EmptyState } from '../../ui/index.ts';

export function BuildPanel() {
  return <EmptyState title="Build">Build settings, progress and the files written are not built yet</EmptyState>;
}
