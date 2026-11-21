import type { ComponentProps } from 'react';
import { ColorField as BaseColorField, TextField as BaseTextField } from './fields/fields';
import { runPreview } from '../canvas/preview';

/** Inspector fields preview on the canvas as they change: their commit runs once in preview mode first. */
export const TextField = (props: ComponentProps<typeof BaseTextField>) => <BaseTextField {...props} onPreview={(v) => runPreview(() => props.onCommit(v))} />;
export const ColorField = (props: ComponentProps<typeof BaseColorField>) => <BaseColorField {...props} onPreview={(v) => runPreview(() => props.onCommit(v))} />;
