import { EFFORT, total, type EffortArm } from './catalogue';

function Mark({ value }: { value: boolean | 'hand-rolled' }) {
  if (value === true) return <span className="win">✓</span>;
  if (value === 'hand-rolled') return <span className="lose">hand-rolled</span>;
  return <span className="muted">—</span>;
}

function Files({ arm }: { arm: EffortArm }) {
  return (
    <span title={arm.files.map(f => `${f.path}: ${f.lines.code} code / ${f.lines.total} total`).join('\n')}>
      {total(arm.files)}
      <span className="muted"> in {arm.files.length} file{arm.files.length === 1 ? '' : 's'}</span>
    </span>
  );
}

export function EffortTab() {
  return (
    <section style={{ display: 'grid', gap: 28 }}>
      <p className="muted" style={{ maxWidth: 820 }}>
        Counted from the source that ran, at build time: each arm's own files, code lines only (blanks and comments out). The library column
        is what the Nirnam arms import — and the size of what an app would come to own, feature by feature, once the plain arm needs the
        same reach. Numbers are lines, not effort; but every hand-rolled cell is a thing that had to be written, tested and kept working.
      </p>
      {EFFORT.map(section => {
        const features = Object.keys(section.featureLabels);
        return (
          <div key={section.id}>
            <h3 style={{ margin: '0 0 8px' }}>{section.title}</h3>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>arm</th>
                    <th>app code lines</th>
                    {features.map(f => (
                      <th key={f} style={{ textAlign: 'center', fontWeight: 400, maxWidth: 120, whiteSpace: 'normal' }}>
                        {section.featureLabels[f]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.arms.map(arm => (
                    <tr key={arm.id}>
                      <td>
                        {arm.label} <span className="muted">{arm.nirnam ? '· Nirnam' : '· no Nirnam'}</span>
                      </td>
                      <td>
                        <Files arm={arm} />
                      </td>
                      {features.map(f => (
                        <td key={f} style={{ textAlign: 'center' }}>
                          <Mark value={arm.features[f] ?? false} />
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td className="muted">library source the Nirnam arms lean on</td>
                    <td className="muted" title={section.library.map(f => `${f.path}: ${f.lines.code}`).join('\n')}>
                      {total(section.library)} in {section.library.length} files
                    </td>
                    <td colSpan={features.length} className="muted" style={{ textAlign: 'left', whiteSpace: 'normal' }}>
                      {section.library.map(f => f.path.replace('Library/src/', '')).join(', ')}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ maxWidth: 820, marginTop: 8 }}>{section.reading}</p>
          </div>
        );
      })}
    </section>
  );
}
