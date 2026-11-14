import { useEffect, useMemo, useRef, useState } from 'react';
import { ALLERGENS, type I18nText } from '@qr/shared';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useI18n, type TKey } from '../lib/i18n';
import { Button, ErrorBox, Field, ImageUpload, Input, ItemImage, Notice, PriceInput, Segmented, Toggle } from '../components/ui';

interface Category { id: string; name: I18nText; importKey: string | null; visible: boolean; position: number; createdByImport: boolean; itemCount: number }
interface Component { id: string; name: I18nText; addonPriceCents: number | null; removable: boolean }
interface Item {
  id: string; code: string | null; name: I18nText; description: I18nText; priceCents: number; imageUrl: string | null;
  visible: boolean; approval: 'pending' | 'approved'; badgeHit: boolean; prepMinutes: number | null; allergens: string[];
  primaryCategoryId: string | null; maxAddons: number | null; missingFromImportAt: string | null;
  categories: { categoryId: string; source: 'import' | 'manual' }[];
  components: { componentId: string; kind: 'base' | 'addon'; maxQty: number }[];
}
const M = '/api/admin/menu';

function I18nInputs({ value, onChange, labels, area }:
  { value: I18nText; onChange: (v: I18nText) => void; labels: [TKey, TKey]; area?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="two-col">
      {(['bg', 'en'] as const).map((l, i) => (
        <Field key={l} label={t(labels[i]!)}>
          {area
            ? <textarea className="input" rows={2} value={value[l] ?? ''} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />
            : <Input value={value[l] ?? ''} onChange={(e) => onChange({ ...value, [l]: e.target.value })} />}
        </Field>
      ))}
    </div>
  );
}

export function MenuPage() {
  const { t, text, price } = useI18n();
  const { data: cats, reload: reloadCats } = useLoad<Category[]>(`${M}/categories`);
  const { data: comps } = useLoad<Component[]>(`${M}/components`);
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const url = `${M}/items?${cat ? `categoryId=${cat}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`;
  const { data: items, reload } = useLoad<Item[]>(url);
  const { data: pending, reload: reloadPending } = useLoad<Item[]>(`${M}/items?approval=pending`);
  const [sel, setSel] = useState<Item | 'new' | null>(null);
  const refresh = () => { reload(); reloadCats(); reloadPending(); };

  const addCategory = async () => {
    const name = prompt(t('menu.nameBg'));
    if (name?.trim()) { await api.post(`${M}/categories`, { name: { bg: name.trim() } }); reloadCats(); }
  };
  const approveAll = async () => { await api.post(`${M}/items/approve`, { ids: pending!.map((p) => p.id) }); refresh(); };

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>{t('nav.menu')}</h1>
        <div className="row">
          <Input placeholder={`🔎 ${t('common.search')}`} value={q} onChange={(e) => setQ(e.target.value)} />
          <a className="btn btn-ghost" href="/" target="_blank" rel="noreferrer">👁 {t('menu.preview')}</a>
          <Button kind="accent" onClick={() => setSel('new')}>{t('menu.newItem')}</Button>
        </div>
      </div>
      {(pending?.length ?? 0) > 0 && (
        <Notice kind="warn">{t('dash.pending')}: {pending!.length} <button className="link-btn" onClick={approveAll}>{t('menu.approveAll')}</button></Notice>
      )}
      <div className="menu-admin">
        <aside className="cat-list">
          <small className="upper muted">{t('menu.categories')}</small>
          <button className={cat === null ? 'is-on' : ''} onClick={() => setCat(null)}>{t('menu.allItems')}</button>
          {cats?.map((c) => (
            <button key={c.id} className={cat === c.id ? 'is-on' : ''} onClick={() => setCat(c.id)}>
              {text(c.name)} {!c.visible && <small className="muted">({t('menu.hidden')})</small>}<b>{c.itemCount}</b>
            </button>
          ))}
          <button className="dashed" onClick={addCategory}>{t('menu.newCategory')}</button>
        </aside>
        <section className="item-list">
          {items?.map((i) => (
            <button key={i.id} className={`item-admin${sel !== 'new' && sel?.id === i.id ? ' is-on' : ''}${i.visible ? '' : ' is-dim'}`} onClick={() => setSel(i)}>
              <ItemImage url={i.imageUrl} name={text(i.name)} size={48} />
              <span className="grow">
                <strong>{text(i.name)} {i.badgeHit && <span className="badge-hit">{t('kiosk.hit')}</span>}</strong>
                <small className="muted">
                  {i.code && <span className="mono">{i.code} · </span>}
                  БГ ✓ · {i.name.en ? 'EN ✓' : <span className="danger">{t('menu.enMissing')}</span>}
                  {i.approval === 'pending' && <span className="warn"> · {t('menu.pending')}</span>}
                  {i.missingFromImportAt && <span className="warn"> · {t('menu.missing')}</span>}
                </small>
              </span>
              <b>{price(i.priceCents)}</b>
            </button>
          ))}
        </section>
        <section className="item-editor">
          {sel ? <ItemEditor key={sel === 'new' ? 'new' : sel.id} item={sel === 'new' ? null : sel} cats={cats ?? []} comps={comps ?? []}
            onSaved={(i) => { refresh(); setSel(i); }} onDeleted={() => { refresh(); setSel(null); }} />
            : <p className="muted center">{t('menu.selectItem')}</p>}
        </section>
      </div>
    </div>
  );
}

function ItemEditor({ item, cats, comps, onSaved, onDeleted }:
  { item: Item | null; cats: Category[]; comps: Component[]; onSaved: (i: Item) => void; onDeleted: () => void }) {
  const { t, text, price } = useI18n();
  const [f, setF] = useState(() => ({
    code: item?.code ?? '', name: item?.name ?? { bg: '' }, description: item?.description ?? {},
    priceCents: item?.priceCents ?? 0, imageUrl: item?.imageUrl ?? '', visible: item?.visible ?? true,
    badgeHit: item?.badgeHit ?? false, prepMinutes: item?.prepMinutes ?? null, allergens: item?.allergens ?? [],
    primaryCategoryId: item?.primaryCategoryId ?? null as string | null,
    extraCategoryIds: item?.categories.filter((c) => c.source === 'manual').map((c) => c.categoryId) ?? [],
  }));
  const [base, setBase] = useState<string[]>(item?.components.filter((c) => c.kind === 'base').map((c) => c.componentId) ?? []);
  const [addons, setAddons] = useState<Record<string, number>>(
    Object.fromEntries(item?.components.filter((c) => c.kind === 'addon').map((c) => [c.componentId, c.maxQty]) ?? []));
  const [maxAddons, setMaxAddons] = useState<number | null>(item?.maxAddons ?? null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setError(null); setSaved(false);
    try {
      const body = { ...f, code: f.code.trim() || null, imageUrl: f.imageUrl.trim() || null,
        name: { bg: f.name.bg ?? '', ...(f.name.en?.trim() ? { en: f.name.en } : {}) } };
      const res = item ? await api.patch<Item>(`${M}/items/${item.id}`, body) : await api.post<Item>(`${M}/items`, body);
      const full = await api.put<Item>(`${M}/items/${res.id}/components`, {
        base, addons: Object.entries(addons).map(([componentId, maxQty]) => ({ componentId, maxQty })), maxAddons });
      setSaved(true);
      onSaved(full);
    } catch (e) { setError(e); }
  };
  const del = async () => { if (item && confirm(t('common.confirmDelete'))) { await api.del(`${M}/items/${item.id}`); onDeleted(); } };

  return (
    <div className="editor">
      <div className="editor-hero"><ItemImage url={f.imageUrl || null} name={f.name.bg || '?'} size={110} /></div>
      {item?.approval === 'pending' && (
        <Notice kind="warn">{t('menu.pending')} <button className="link-btn" onClick={async () => {
          await api.post(`${M}/items/approve`, { ids: [item.id] }); onSaved({ ...item, approval: 'approved' });
        }}>{t('menu.approve')}</button></Notice>
      )}
      <I18nInputs value={f.name} onChange={(name) => setF({ ...f, name })} labels={['menu.nameBg', 'menu.nameEn']} />
      <div className="three-col">
        <Field label={t('menu.price')}><PriceInput cents={f.priceCents} onChange={(c) => setF({ ...f, priceCents: c ?? 0 })} /></Field>
        <Field label={t('menu.code')}><Input value={f.code} maxLength={6} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label={t('menu.prep')}><Input type="number" min={0} max={240} value={f.prepMinutes ?? ''}
          onChange={(e) => setF({ ...f, prepMinutes: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
      </div>
      <I18nInputs area value={f.description} onChange={(description) => setF({ ...f, description })} labels={['menu.descBg', 'menu.descEn']} />
      <Field label={t('menu.image')}><ImageUpload value={f.imageUrl} onChange={(imageUrl) => setF({ ...f, imageUrl })} /></Field>
      <div className="row">
        <Toggle checked={f.visible} onChange={(visible) => setF({ ...f, visible })} label={t('menu.visible')} />
        <Toggle checked={f.badgeHit} onChange={(badgeHit) => setF({ ...f, badgeHit })} label={t('menu.hit')} />
      </div>
      <div className="two-col">
        <Field label={t('menu.primary')}>
          <select className="input" value={f.primaryCategoryId ?? ''} onChange={(e) => setF({ ...f, primaryCategoryId: e.target.value || null })}>
            <option value="">{t('menu.noCategory')}</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{text(c.name)}</option>)}
          </select>
        </Field>
        <Field label={t('menu.extra')}>
          <div className="chips chips-wrap">{cats.filter((c) => c.id !== f.primaryCategoryId).map((c) => {
            const on = f.extraCategoryIds.includes(c.id);
            return <button type="button" key={c.id} className={on ? 'is-on' : ''} onClick={() => setF({ ...f,
              extraCategoryIds: on ? f.extraCategoryIds.filter((x) => x !== c.id) : [...f.extraCategoryIds, c.id] })}>{text(c.name)}</button>;
          })}</div>
        </Field>
      </div>
      <Field label={t('menu.allergens')}>
        <div className="chips chips-wrap">{ALLERGENS.map((a) => {
          const on = f.allergens.includes(a);
          return <button type="button" key={a} className={on ? 'is-on' : ''}
            onClick={() => setF({ ...f, allergens: on ? f.allergens.filter((x) => x !== a) : [...f.allergens, a] })}>{t(`allergen.${a}`)}</button>;
        })}</div>
      </Field>
      <div className="card-inner">
        <strong>{t('menu.composition')}</strong>
        <p className="muted small">{t('menu.compositionHint')}</p>
        <div className="chips chips-wrap">{comps.map((c) => {
          const on = base.includes(c.id);
          return <button type="button" key={c.id} className={on ? 'is-on' : ''} onClick={() => setBase(on ? base.filter((x) => x !== c.id) : [...base, c.id])}>
            {c.removable ? '× ' : '🔒 '}{text(c.name)}</button>;
        })}</div>
      </div>
      <div className="card-inner">
        <div className="row-between"><strong>{t('menu.allowedAddons')}</strong>
          <span className="row small">{t('menu.maxAddons')} <Input type="number" min={0} max={50} className="input-xs" value={maxAddons ?? ''}
            onChange={(e) => setMaxAddons(e.target.value === '' ? null : Number(e.target.value))} /></span></div>
        {comps.filter((c) => c.addonPriceCents !== null).map((c) => {
          const on = c.id in addons;
          return (
            <div key={c.id} className="opt-row">
              <input type="checkbox" className="check" checked={on} onChange={(e) => {
                const n = { ...addons }; if (e.target.checked) n[c.id] = 1; else delete n[c.id]; setAddons(n);
              }} />
              <span className="grow">{text(c.name)}</span>
              <span className="muted">+{price(c.addonPriceCents!)}</span>
              {on && <select className="input input-xs" value={addons[c.id]} onChange={(e) => setAddons({ ...addons, [c.id]: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{t('menu.upTo', { n })}</option>)}</select>}
            </div>
          );
        })}
      </div>
      <ErrorBox error={error} />
      {saved && <Notice kind="ok">{t('common.saved')}</Notice>}
      <div className="editor-foot">
        <Button kind="accent" onClick={save}>{t('common.save')}</Button>
        {item && <button className="link-btn danger" onClick={del}>{t('menu.deleteItem')}</button>}
      </div>
    </div>
  );
}

export function Filters() {
  const { t, text } = useI18n();
  const { data: cats, reload } = useLoad<Category[]>(`${M}/categories`);
  const [sel, setSel] = useState<Category | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (sel && cats) setSel(cats.find((c) => c.id === sel.id) ?? null); }, [cats]); // eslint-disable-line
  const move = async (i: number, d: -1 | 1) => {
    const ids = cats!.map((c) => c.id);
    const j = i + d; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await api.put(`${M}/categories/order`, { ids }); reload();
  };
  const patch = (id: string, body: object) => api.patch(`${M}/categories/${id}`, body).then(reload).catch(setError);
  return (
    <div className="page">
      <h1>{t('filters.title')}</h1>
      <div className="card row chips-preview">
        <small className="upper muted">{t('filters.clientSees')}</small>
        <span className="chip is-on">{t('common.all')}</span>
        {cats?.filter((c) => c.visible && c.itemCount > 0).map((c) => <span key={c.id} className="chip">{text(c.name)}</span>)}
      </div>
      <div className="two-col-wide">
        <div className="card">
          <div className="row-between"><strong>🏷 {t('nav.filters')}</strong><small className="muted">{t('filters.orderHint')}</small></div>
          {cats?.map((c, i) => (
            <div key={c.id} className={`filter-row${sel?.id === c.id ? ' is-on' : ''}`} onClick={() => setSel(c)}>
              <span className="col"><button onClick={(e) => { e.stopPropagation(); void move(i, -1); }}>▲</button>
                <button onClick={(e) => { e.stopPropagation(); void move(i, 1); }}>▼</button></span>
              <span className="grow"><strong>{text(c.name)} {c.createdByImport && <span className="badge-new">{t('filters.new')}</span>}</strong>
                <small className="muted">{t('filters.items', { n: c.itemCount })}{c.importKey ? ` · ${t('filters.fromImport')}` : ''}</small></span>
              <span onClick={(e) => e.stopPropagation()}><Toggle checked={c.visible} onChange={(v) => patch(c.id, { visible: v })} /></span>
            </div>
          ))}
          <Button kind="ghost" onClick={async () => {
            const name = prompt(t('menu.nameBg')); if (name?.trim()) { await api.post(`${M}/categories`, { name: { bg: name.trim() } }); reload(); }
          }}>{t('filters.newFilter')}</Button>
        </div>
        {sel && <FilterEditor key={sel.id} cat={sel} onSave={(b) => patch(sel.id, b)}
          onDelete={async () => { if (confirm(t('common.confirmDelete'))) { await api.del(`${M}/categories/${sel.id}`); setSel(null); reload(); } }} />}
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

function FilterEditor({ cat, onSave, onDelete }: { cat: Category; onSave: (b: object) => void; onDelete: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(cat.name);
  const [key, setKey] = useState(cat.importKey ?? '');
  return (
    <div className="card form-grid">
      <h2>„{cat.name.bg}“</h2>
      <I18nInputs value={name} onChange={setName} labels={['menu.nameBg', 'menu.nameEn']} />
      <Field label={t('filters.importKey')}><Input value={key} onChange={(e) => setKey(e.target.value)} /></Field>
      <div className="row">
        <Button kind="accent" onClick={() => onSave({ name: { bg: name.bg ?? '', ...(name.en?.trim() ? { en: name.en } : {}) }, importKey: key.trim() || null })}>{t('common.save')}</Button>
        <button className="link-btn danger" onClick={onDelete}>{t('common.delete')}</button>
      </div>
    </div>
  );
}

export function Components() {
  const { t, text } = useI18n();
  const { data, reload } = useLoad<Component[]>(`${M}/components`);
  const [error, setError] = useState<unknown>(null);
  const patch = (id: string, body: object) => api.patch(`${M}/components/${id}`, body).then(reload).catch(setError);
  return (
    <div className="page">
      <div className="page-head"><h1>{t('nav.components')}</h1>
        <Button onClick={async () => { const name = prompt(t('comp.name')); if (name?.trim()) {
          await api.post(`${M}/components`, { name: { bg: name.trim() } }).catch(setError); reload(); } }}>{t('comp.new')}</Button></div>
      <div className="card">
        <h2>🧩 {t('comp.library')}</h2>
        <table className="table">
          <thead><tr><th>{t('comp.name')}</th><th>{t('menu.nameEn')}</th><th>{t('comp.addon')}</th><th>{t('comp.price')}</th><th>{t('comp.removable')}</th><th /></tr></thead>
          <tbody>{data?.map((c) => (
            <tr key={c.id}>
              <td>{text(c.name)}</td>
              <td><Input defaultValue={c.name.en ?? ''} onBlur={(e) => e.target.value !== (c.name.en ?? '') &&
                patch(c.id, { name: { bg: c.name.bg, ...(e.target.value.trim() ? { en: e.target.value.trim() } : {}) } })} /></td>
              <td><Toggle checked={c.addonPriceCents !== null} onChange={(v) => patch(c.id, { addonPriceCents: v ? 0 : null })} /></td>
              <td>{c.addonPriceCents !== null ? <PriceInput cents={c.addonPriceCents} onChange={(v) => patch(c.id, { addonPriceCents: v ?? 0 })} /> : '—'}</td>
              <td><Toggle checked={c.removable} onChange={(v) => patch(c.id, { removable: v })} /></td>
              <td><button className="link-btn danger" onClick={() => confirm(t('common.confirmDelete')) && api.del(`${M}/components/${c.id}`).then(reload)}>×</button></td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted small">{t('comp.hint')}</p>
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

interface ImportSettings { autoApproveNew: boolean; missingItems: 'keep' | 'hide'; maxErrorRatio: number; sftpEnabled: boolean;
  encoding: 'auto' | 'utf-8' | 'windows-1251'; notifyOnError: boolean; columnMap: Record<string, string> }
interface Run { id: string; filename: string; status: string; created: number; updated: number; errorCount: number;
  errors: { row: number; code: string; value?: string }[]; preview: string; createdAt: string; source: string }

export function Import() {
  const { t, tx } = useI18n();
  const { data: s, reload: reloadS } = useLoad<ImportSettings>(`${M}/import/settings`);
  const { data: runs, reload } = useLoad<Run[]>(`${M}/import/runs`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const save = (b: Partial<ImportSettings>) => api.put(`${M}/import/settings`, b).then(reloadS).catch(setError);
  const upload = async (f: File) => {
    setBusy(true); setError(null);
    try { await api.upload(`${M}/import?filename=${encodeURIComponent(f.name)}`, f); reload(); } catch (e) { setError(e); }
    finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  const last = runs?.[0];
  const statusLabel = (st: string) => tx(`import.status.${st}`, 'common.none');
  const colMap = useMemo(() => Object.entries(s?.columnMap ?? {}).map(([k, v]) => `${k} → ${v}`).join('\n'), [s]);
  return (
    <div className="page">
      <div className="page-head"><h1>{t('import.title')}</h1>
        <input ref={file} type="file" accept=".csv,.xlsx,.txt" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button kind="accent" disabled={busy} onClick={() => file.current?.click()}>⬆ {t('import.upload')}</Button></div>
      <ErrorBox error={error} />
      <div className="two-col-wide">
        <div>
          {s && (
            <div className="card form-grid">
              <Toggle checked={s.sftpEnabled} onChange={(v) => save({ sftpEnabled: v })} label={<strong>📥 {t('import.auto')}</strong>} />
              <p className="muted small">{t('import.folders')}</p>
              <Field label={t('import.encoding')}>
                <Segmented value={s.encoding} onChange={(v) => save({ encoding: v })} options={[
                  { value: 'auto', label: t('import.encoding.auto') }, { value: 'utf-8', label: 'UTF-8' }, { value: 'windows-1251', label: 'Windows-1251' }]} />
              </Field>
              <h2>🧭 {t('import.rules')}</h2>
              <Toggle checked={s.autoApproveNew} onChange={(v) => save({ autoApproveNew: v })} label={t('import.autoApprove')} />
              <Field label={t('import.missing')}>
                <Segmented value={s.missingItems} onChange={(v) => save({ missingItems: v })}
                  options={[{ value: 'keep', label: t('import.missing.keep') }, { value: 'hide', label: t('import.missing.hide') }]} />
              </Field>
              <Field label={t('import.maxErrors')}><Input type="number" min={0} max={100} defaultValue={Math.round(s.maxErrorRatio * 100)}
                onBlur={(e) => save({ maxErrorRatio: Math.min(100, Math.max(0, Number(e.target.value))) / 100 })} /></Field>
              <Toggle checked={s.notifyOnError} onChange={(v) => save({ notifyOnError: v })} label={t('import.notify')} />
              <p className="muted small">{t('import.keepNote')}</p>
              <Field label={t('import.columns')} hint={t('import.columnsHint')}>
                <textarea className="input mono" rows={3} defaultValue={colMap} placeholder="Артикул № → code" onBlur={(e) => {
                  const map: Record<string, string> = {};
                  for (const line of e.target.value.split('\n')) {
                    const [k, v] = line.split('→').map((x) => x.trim());
                    if (k && v) map[k] = v;
                  }
                  void save({ columnMap: map });
                }} />
              </Field>
            </div>
          )}
        </div>
        <div>
          <div className="card">
            <h2>🕘 {t('import.history')}</h2>
            <table className="table">
              <thead><tr><th>{t('import.time')}</th><th>{t('import.file')}</th><th>{t('import.new')}</th><th>{t('import.updated')}</th><th>{t('import.errors')}</th><th>{t('import.result')}</th></tr></thead>
              <tbody>{runs?.map((r) => (
                <tr key={r.id}><td>{new Date(r.createdAt).toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="mono small">{r.filename}</td><td>{r.created}</td><td>{r.updated}</td><td>{r.errorCount}</td>
                  <td><span className={`tag tag-${r.status}`}>{statusLabel(r.status)}</span></td></tr>
              ))}</tbody>
            </table>
            {last?.errors.slice(0, 5).map((e, i) => (
              <div key={i} className="alert alert-warn small">⚠ {t('import.row', { n: e.row })}: {tx(`importerr.${e.code}`, 'err.generic')}{e.value ? ` („${e.value}“)` : ''}</div>
            ))}
          </div>
          {last?.preview && <div className="card"><h2>👁 {t('import.firstRows')}</h2><pre className="pre">{last.preview}</pre></div>}
        </div>
      </div>
    </div>
  );
}
