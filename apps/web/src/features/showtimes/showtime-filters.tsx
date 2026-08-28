import type { Cinema } from '@cinema/contracts';

import { Button } from '../../shared/ui/button';

export interface ShowtimeFilterValue {
  cinemaId?: string;
  date?: string;
}

export function ShowtimeFilters({
  cinemas,
  value,
  onChange,
}: {
  cinemas: Cinema[];
  value: ShowtimeFilterValue;
  onChange: (next: ShowtimeFilterValue) => void;
}) {
  const hasFilters = Boolean(value.cinemaId ?? value.date);

  return (
    <div className="mb-6 flex flex-wrap items-end gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Cinema</span>
        <select
          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          value={value.cinemaId ?? ''}
          onChange={(event) => onChange({ ...value, cinemaId: event.target.value || undefined })}
        >
          <option value="">All cinemas</option>
          {cinemas.map((cinema) => (
            <option key={cinema.id} value={cinema.id}>
              {cinema.name} — {cinema.city}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Date</span>
        <input
          type="date"
          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          value={value.date ?? ''}
          onChange={(event) => onChange({ ...value, date: event.target.value || undefined })}
        />
      </label>

      {hasFilters ? <Button onClick={() => onChange({})}>Clear filters</Button> : null}
    </div>
  );
}
