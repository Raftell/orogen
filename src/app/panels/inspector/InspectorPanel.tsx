// The component of the inspector panel in its starting state (index.ts says what the panel is to become).

import { EmptyState } from '../../ui/index.ts';

export function InspectorPanel() {
  return <EmptyState title="Inspector">The parameters of the selected node are not built yet</EmptyState>;
}
