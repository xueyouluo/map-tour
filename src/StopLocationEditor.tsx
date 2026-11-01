import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Loader2, MapPin, Search } from 'lucide-react';
import { AppDialog } from './AppDialog';
import { getConfig } from './api';
import { loadAMap, searchPoiCandidates } from './amap';
import type { Itinerary, PoiCandidate, Stop } from './shared/itinerary';
import { hasValidLocation } from './shared/stopLocations';
import { stopLocationDefaults } from './shared/stopLocationDefaults';
import './stopLocationEditor.css';

export function StopLocationEditor({
  stop,
  itinerary,
  fork,
  onClose,
  onSave
}: {
  stop: Stop;
  itinerary: Itinerary;
  fork: boolean;
  onClose: () => void;
  onSave: (candidate: PoiCandidate) => Promise<void>;
}) {
  const [query, setQuery] = useState(stop.name);
  const [defaults] = useState(() => stopLocationDefaults(stop, itinerary));
  const [province, setProvince] = useState(defaults.province || '');
  const [city, setCity] = useState(defaults.city || '');
  const [district, setDistrict] = useState(defaults.district || '');
  const [results, setResults] = useState<PoiCandidate[]>(
    (stop.poiMatch?.candidates || []).filter((p) =>
      hasValidLocation(p.location)
    )
  );
  const [selected, setSelected] = useState<PoiCandidate | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const serial = useRef(0);
  useEffect(
    () => () => {
      serial.current++;
    },
    []
  );
  function edit(setter: (value: string) => void, value: string) {
    serial.current++;
    setter(value);
    setSelected(null);
    setResults([]);
    setSearching(false);
    setSearched(false);
    setError('');
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    if (searching || saving) return;
    const request = ++serial.current;
    setSearching(true);
    setSelected(null);
    setError('');
    setResults([]);
    try {
      if (!city.trim() && !province.trim())
        throw new Error('请先填写省份或城市，避免找到异地同名地点。');
      const config = await getConfig();
      if (!config.amapKey) throw new Error('地图服务尚未配置，请联系管理员。');
      const AMap = await loadAMap(config.amapKey, config.hasAmapProxy);
      const places = await searchPoiCandidates(AMap, query, {
        province: province.trim(),
        city: city.trim(),
        district: district.trim()
      });
      if (request !== serial.current) return;
      setResults(places);
      setSearched(true);
    } catch (issue) {
      if (request === serial.current)
        setError(issue instanceof Error ? issue.message : '搜索失败，请重试。');
    } finally {
      if (request === serial.current) setSearching(false);
    }
  }
  async function save() {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await onSave(selected);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : '保存失败，请重试。');
      setSaving(false);
    }
  }
  return (
    <AppDialog
      title={`修改地点 · ${stop.name}`}
      busy={saving}
      onClose={onClose}
    >
      <div className="stop-location-editor">
        <p className="place-editor-intro">
          {(defaults.province || defaults.city) && '已预填所在地区，可直接修改。'}
          搜索并选择准确的位置。轮渡请选择实际码头；“武汉站/汉口站”这类二选一地点请选择实际出发站。
        </p>
        <form onSubmit={search}>
          <fieldset disabled={saving}>
            <div className="place-region-fields">
              <label>
                省份
                <input
                  value={province}
                  onChange={(e) => edit(setProvince, e.target.value)}
                  placeholder="例如：湖北省"
                />
              </label>
              <label>
                城市
                <input
                  value={city}
                  onChange={(e) => edit(setCity, e.target.value)}
                  placeholder="例如：武汉市"
                />
              </label>
              <label>
                区县（选填）
                <input
                  value={district}
                  onChange={(e) => edit(setDistrict, e.target.value)}
                  placeholder="缩小搜索范围"
                />
              </label>
            </div>
            <label>
              地点名称
              <input
                value={query}
                onChange={(e) => edit(setQuery, e.target.value)}
                placeholder="输入景点、码头或车站名称"
                required
                maxLength={120}
              />
            </label>
            <button
              className="place-search-button"
              type="submit"
              disabled={searching || !query.trim()}
            >
              {searching ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Search size={16} />
              )}{' '}
              {searching ? '搜索中…' : '搜索地点'}
            </button>
          </fieldset>
        </form>
        <div
          className="place-search-results"
          aria-live="polite"
          aria-busy={searching}
        >
          {results.length > 0 && (
            <p>找到 {results.length} 个地点，请核对地址后选择</p>
          )}
          {results.map((poi, index) => (
            <button
              key={poi.poiId || index}
              className={`place-result ${selected === poi ? 'selected' : ''}`}
              type="button"
              aria-pressed={selected === poi}
              disabled={saving}
              onClick={() => setSelected(poi)}
            >
              <MapPin size={17} />
              <span>
                <strong>{poi.name}</strong>
                <small>
                  {[poi.province, poi.city, poi.district]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                <small>{poi.address || '暂无详细地址'}</small>
              </span>
              {selected === poi && <Check size={17} />}
            </button>
          ))}
          {searched && !results.length && (
            <p>
              没有找到符合省市区的地点。试试更具体的名称，或清空区县扩大搜索范围。
            </p>
          )}
        </div>
        {error && (
          <p className="place-editor-error" role="alert">
            {error}
          </p>
        )}
        <div className="place-editor-footer">
          <p>
            {fork
              ? '这是分享行程，将另存为你的行程后修改，占用 1 个新建额度。'
              : '保存后只更新与这个地点相连的路线，不占用新建额度。'}
          </p>
          <button
            type="button"
            onClick={save}
            disabled={!selected || saving || searching}
          >
            {saving ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}{' '}
            {saving ? '正在保存…' : fork ? '另存并使用此地点' : '使用此地点'}
          </button>
        </div>
      </div>
    </AppDialog>
  );
}
