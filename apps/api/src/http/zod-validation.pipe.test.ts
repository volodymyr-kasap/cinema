import type { ArgumentMetadata } from '@nestjs/common';
import { z } from 'zod';

import { ValidationFailedError } from './errors';
import { zodPipe } from './zod-validation.pipe';

const schema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

// Nest hands every pipe the argument's metadata alongside the value. zodPipe
// ignores it, but PipeTransform declares it, so the call has to supply it.
const metadata: ArgumentMetadata = { type: 'query' };

describe('zodPipe', () => {
  it('returns the parsed value, applying coercion and defaults', () => {
    const pipe = zodPipe(schema);

    expect(pipe.transform({ limit: '30' }, metadata)).toEqual({ limit: 30 });
    expect(pipe.transform({}, metadata)).toEqual({ limit: 20 });
  });

  it('throws ValidationFailedError with a readable detail', () => {
    const pipe = zodPipe(schema);

    expect(() => pipe.transform({ limit: '0' }, metadata)).toThrow(ValidationFailedError);
    expect(() => pipe.transform({ limit: '0' }, metadata)).toThrow(/limit/);
  });
});
