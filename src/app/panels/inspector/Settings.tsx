// The project settings (runtime.md 4.2), shown while no node is selected, with the controls the parameters have.
// The size and the height range are in metres; the sea level is a height, shown in metres as well; the build
// resolution is one of Unreal's landscape sizes, and the preview a level of it with the resolution it gives.

import { useEffect, useId, useMemo, type ReactNode } from 'react';

import { newDoc, type ProjectSettings } from '../../../core/runtime.ts';
import { CommandButton, formatMetres, metricUnits, NumberField, SectionTitle, Select, useApp, type NumberRange, type NumberUnits } from '../../ui/index.ts';
import { createGesture, setSettingOf, settingKey } from './edit.ts';
import styles from './inspector.module.css';
import { SEED_SPEC, shownPrecision } from './model.ts';
import { RowEnd, RowLabel } from './Params.tsx';
import {
  buildResolutionOptions, formatSpacing, HEIGHT_RANGE_RANGE, highestPointText, METRE_UNITS, metresPerVertex, previewLevelLabel, previewLevels, previewResolutionText, resolutionLabel,
  SEA_LEVEL_RANGE, SETTING_HELP, SETTING_LABELS, TERRAIN_SIZE_RANGE, type SettingName,
} from './settings.ts';

const DEFAULTS: ProjectSettings = newDoc().settings;

function Row(props: { readonly name: SettingName; readonly value: number; readonly id?: string; readonly children: ReactNode }) {
  const app = useApp();
  const { name } = props;
  return (
    <div className={styles.row} data-setting={name} data-changed={props.value !== DEFAULTS[name] ? '' : undefined}>
      <RowLabel label={SETTING_LABELS[name]} help={SETTING_HELP[name]} htmlFor={props.id} />
      <div className={styles.control}>{props.children}</div>
      <RowEnd changed={props.value !== DEFAULTS[name]} reset={() => setSettingOf(app.ctx, name, DEFAULTS[name])} />
    </div>
  );
}

function NumberSetting(props: {
  readonly name: SettingName;
  readonly value: number;
  readonly range: NumberRange;
  readonly precision: number;
  readonly unit?: string;
  readonly units?: NumberUnits;
  readonly secondary?: string;
  readonly children?: ReactNode;
}) {
  const app = useApp();
  const id = useId();
  const { name } = props;
  const gesture = useMemo(() => createGesture(app.ctx.doc, settingKey(name)), [app.ctx.doc, name]);
  useEffect(() => () => gesture.end(true), [gesture]);
  return (
    <Row name={name} value={props.value} id={id}>
      <NumberField
        id={id}
        className={styles.fill}
        aria-label={SETTING_LABELS[name]}
        value={props.value}
        {...props.range}
        precision={props.precision}
        unit={props.unit}
        units={props.units}
        secondary={props.secondary}
        onChange={(value) => setSettingOf(app.ctx, name, value)}
        onScrubStart={gesture.begin}
        onScrubEnd={gesture.end}
      />
      {props.children}
    </Row>
  );
}

/** Whole metres as they are, anything finer with two decimals. */
const metrePrecision = (value: number): number => (Number.isInteger(value) ? 0 : 2);

export function SettingsView(props: { readonly settings: ProjectSettings }) {
  const app = useApp();
  const { settings } = props;
  const buildId = useId();
  const previewId = useId();
  // The levels are those of the build resolution alone; the settings are another object for every step of a drag.
  const levels = useMemo(() => previewLevels(settings), [settings.buildResolution]);

  return (
    <>
      <header className={styles.header} data-inspector-header="settings">
        <div className={styles.category} />
        <div className={styles.headerMain}>
          <div className={styles.titleLine}>
            <div className={styles.multiTitle}>Project Settings</div>
          </div>
          <div className={styles.typeLine}>
            <span className={styles.typeTitle}>No node is selected</span>
          </div>
        </div>
      </header>
      <div className={styles.scroll} data-inspector-body="">
        <SectionTitle>Terrain</SectionTitle>
        <NumberSetting name="terrainSize" value={settings.terrainSize} range={TERRAIN_SIZE_RANGE} precision={metrePrecision(settings.terrainSize)} unit=" m" units={METRE_UNITS} />
        <NumberSetting name="heightRange" value={settings.heightRange} range={HEIGHT_RANGE_RANGE} precision={metrePrecision(settings.heightRange)} unit=" m" units={METRE_UNITS} />
        <NumberSetting
          name="seaLevel"
          value={settings.seaLevel}
          range={SEA_LEVEL_RANGE}
          precision={shownPrecision({ precision: 3, range: SEA_LEVEL_RANGE }, settings.seaLevel)}
          units={metricUnits(settings.heightRange)}
          secondary={formatMetres(settings.seaLevel, settings.heightRange)}
        />
        <NumberSetting name="seed" value={settings.seed} range={SEED_SPEC.range} precision={0}>
          <CommandButton command="inspector.randomizeSeed" icon="dice" size="small" />
        </NumberSetting>

        <SectionTitle>Resolution</SectionTitle>
        <Row name="buildResolution" value={settings.buildResolution} id={buildId}>
          <Select
            id={buildId}
            aria-label={SETTING_LABELS.buildResolution}
            value={String(settings.buildResolution)}
            options={buildResolutionOptions(settings.buildResolution)}
            onChange={(value) => setSettingOf(app.ctx, 'buildResolution', Number(value))}
          />
        </Row>
        <Row name="previewLevel" value={settings.previewLevel} id={previewId}>
          <Select
            id={previewId}
            aria-label={SETTING_LABELS.previewLevel}
            value={String(settings.previewLevel)}
            options={levels.map((level) => ({ value: String(level.level), label: previewLevelLabel(level) }))}
            onChange={(value) => setSettingOf(app.ctx, 'previewLevel', Number(value))}
          />
        </Row>
        <dl className={styles.derived} data-settings-derived="">
          <div className={styles.fact}>
            {/* A change of the build resolution keeps the previews as near to this as its levels allow (runtime.md 4.2). */}
            <dt>Previews at</dt>
            <dd data-derived="preview">{previewResolutionText(settings)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Vertex spacing</dt>
            <dd data-derived="spacing">{formatSpacing(metresPerVertex(settings))} in a build of {resolutionLabel(settings.buildResolution)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Highest point</dt>
            <dd data-derived="height">{highestPointText(settings)}</dd>
          </div>
        </dl>
      </div>
    </>
  );
}
