// The notification area (runtime.md 8.7 rule 3): what the engine or a command has to say that is no state of
// the project. An error stays until it is dismissed; the others leave by themselves.

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { Icon, IconButton } from '../ui/index.ts';
import type { Shell, ShownNotice } from './shell.ts';

const STAYS_MS = { info: 5000, warning: 9000 } as const;

function NoticeView(props: { readonly shell: Shell; readonly notice: ShownNotice }) {
  const { shell, notice } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (notice.level === 'error' || open) return undefined;
    const timer = setTimeout(() => shell.dismissNotice(notice.id), STAYS_MS[notice.level]);
    return () => clearTimeout(timer);
    // A message that arrives again stays as long as a new one.
  }, [shell, notice.id, notice.level, notice.count, open]);
  return (
    <div className="og-notice" role={notice.level === 'error' ? 'alert' : 'status'} data-ui="notice" data-level={notice.level}>
      <Icon className="og-notice-icon" name={notice.level === 'info' ? 'info' : notice.level} />
      <div className="og-notice-text">
        {notice.message}
        {notice.count > 1 ? <span className="og-notice-count"> ({notice.count} times)</span> : null}
        {open && notice.detail ? <pre className="og-notice-detail">{notice.detail}</pre> : null}
      </div>
      {notice.detail ? <IconButton icon={open ? 'chevron-up' : 'chevron-down'} label={open ? 'Hide Details' : 'Show Details'} size="small" onClick={() => setOpen(!open)} /> : null}
      <IconButton icon="close" label="Dismiss" size="small" onClick={() => shell.dismissNotice(notice.id)} />
    </div>
  );
}

export function Notices(props: { readonly shell: Shell }) {
  const notices = useStore(props.shell.state, (state) => state.notices);
  if (notices.length === 0) return null;
  return (
    <div className="og-notices" data-shell="notices">
      {notices.map((notice) => <NoticeView key={notice.id} shell={props.shell} notice={notice} />)}
    </div>
  );
}
