// The import guide: the import by hand of the user documentation, word for word, with the numbers of the last
// build under the steps they belong to.

import type { ReactNode } from 'react';

import { Button, Dialog } from '../../ui/index.ts';
import { GUIDE_DOCUMENT, GUIDE_LEGEND, GUIDE_SECTIONS } from './model/guide-text.ts';
import { inlineParts, STEP_GROUPS, STEPS_SECTION, type GuideItem, type GuideSection } from './model/guide.ts';
import { importGroups, type ImportGroup } from './model/manifest.ts';
import { css, Note, useBuildScope, useModel, usePanel } from './parts.tsx';
import { ImportRows } from './ResultSection.tsx';

function Inline(props: { readonly text: string }): ReactNode {
  return inlineParts(props.text).map((part, index) => (
    part.kind === 'code' ? <code key={index}>{part.text}</code> : part.kind === 'strong' ? <strong key={index}>{part.text}</strong> : part.text
  ));
}

function Item(props: { readonly item: GuideItem; readonly values: readonly ImportGroup[] }) {
  const { item } = props;
  return (
    <li>
      <Inline text={item.text} />
      {item.bullets ? <ul>{item.bullets.map((bullet) => <li key={bullet}><Inline text={bullet} /></li>)}</ul> : null}
      {item.more?.map((paragraph) => <p key={paragraph}><Inline text={paragraph} /></p>)}
      {props.values.length > 0 ? <div className={css.guideValues} data-build="guide-values"><ImportRows groups={props.values} compact /></div> : null}
    </li>
  );
}

function SectionText(props: { readonly section: GuideSection; readonly groups: readonly ImportGroup[] }) {
  const { section } = props;
  const items = section.items.map((item, index) => {
    const wanted = section.number === STEPS_SECTION ? STEP_GROUPS[index + 1] ?? [] : [];
    return <Item key={item.text} item={item} values={props.groups.filter((group) => wanted.includes(group.id))} />;
  });
  return (
    <section data-build-guide={section.number}>
      <h4>{section.number}. {section.title}</h4>
      {section.before.map((paragraph) => <p key={paragraph}><Inline text={paragraph} /></p>)}
      {section.list === 'ordered' ? <ol>{items}</ol> : section.list === 'bullets' ? <ul>{items}</ul> : null}
      {section.after.map((paragraph) => <p key={paragraph}><Inline text={paragraph} /></p>)}
    </section>
  );
}

export function GuideDialog() {
  const model = useModel();
  const open = usePanel((state) => state.guideOpen);
  const files = usePanel((state) => state.files);
  const { build, mine, changed } = useBuildScope();
  if (!open) return null;
  const current = mine && !build.running && build.result?.status === 'ok' && files !== null && files.requestId === build.requestId && files.manifest?.ok === true;
  const groups = current && files.manifest?.ok ? importGroups(files.manifest.value, files.folder) : [];
  return (
    <Dialog
      open name="import-guide" width={760} title="Importing a build into Unreal Engine 5.8"
      onClose={() => model.setGuideOpen(false)}
      actions={<Button variant="primary" data-action="close" onClick={() => model.setGuideOpen(false)}>Close</Button>}
    >
      <div className={css.guide} data-build="guide">
        <Note tone="warning" id="guide-legend">
          <p><Inline text={GUIDE_LEGEND.warning} /></p>
          <p><Inline text={GUIDE_LEGEND.lead} /></p>
          {GUIDE_LEGEND.marks.map((mark) => <p key={mark}><Inline text={mark} /></p>)}
        </Note>
        {groups.length > 0 ? (
          <Note tone={changed ? 'warning' : 'info'} id="guide-values-note">
            {changed
              ? 'The values under the steps are those of the last build, and the project has changed since. Build again before you import.'
              : 'The values under the steps are those of the last build, as its manifest states them.'}
          </Note>
        ) : (
          <Note id="guide-values-note">Build the project, and the values of its manifest stand under the steps they belong to.</Note>
        )}
        {GUIDE_SECTIONS.map((section) => <SectionText key={section.number} section={section} groups={groups} />)}
        <p>
          This is the text of sections 1 to 4 of <code>{GUIDE_DOCUMENT}</code>. Its sections 5 to 8 hold a worked example, the acceptance
          test, the experimental plugin and the list of everything that is still unverified.
        </p>
      </div>
    </Dialog>
  );
}
