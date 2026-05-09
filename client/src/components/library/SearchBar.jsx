// @ts-check
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { mono } from '../shared/hud-tokens';
import { useLang } from '../../context/LanguageContext';

/** @typedef {{ focus: () => void, clear: () => void }} SearchBarHandle */

const s = {
  wrap: (focused) => ({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    height: 34,
    padding: '0 12px',
    background: focused
      ? 'oklch(20% 0.04 210 / 0.55)'
      : 'oklch(14% 0.04 210 / 0.40)',
    border: focused
      ? '1px solid rgba(10,132,255,0.55)'
      : '1px solid rgba(84,84,88,0.45)',
    borderRadius: 12,
    transition: 'background 150ms ease-out, border-color 150ms ease-out, width 200ms cubic-bezier(0.4,0,0.2,1)',
    width: focused ? 280 : 180,
  }),
  prefix: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.10em',
    flexShrink: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: '#fff',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    padding: 0,
    caretColor: '#0a84ff',
  },
  // Trailing key hint — fades out once user starts typing.
  hint: {
    ...mono,
    fontSize: 9,
    color: 'rgba(235,235,245,0.30)',
    background: 'rgba(120,120,128,0.18)',
    padding: '2px 5px',
    borderRadius: 4,
    letterSpacing: '0.10em',
    flexShrink: 0,
  },
  clearBtn: {
    ...mono,
    background: 'transparent',
    border: 'none',
    color: 'rgba(235,235,245,0.45)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: 4,
    flexShrink: 0,
  },
};

/**
 * SearchBar — mono input, focus expands width, `/` global key brings focus.
 *
 * Power-user contract: parent registers `/` keydown listener and calls
 * `ref.current.focus()`. Esc inside the input clears + blurs. The component
 * itself only owns local focus state and its own value bridge to `onChange`.
 *
 * @typedef {Object} SearchBarProps
 * @property {string} value
 * @property {(next: string) => void} onChange
 * @property {string} [placeholder]
 *
 * @type {React.ForwardRefExoticComponent<SearchBarProps & React.RefAttributes<SearchBarHandle>>}
 */
const SearchBar = forwardRef(function SearchBar(
  { value, onChange, placeholder },
  ref,
) {
  const { t } = useLang();
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const [focused, setFocused] = useState(false);
  const effectivePlaceholder = placeholder ?? t('library.search.placeholder');

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
      clear() {
        onChange('');
      },
    }),
    [onChange],
  );

  return (
    <div style={s.wrap(focused || value.length > 0)} data-testid="library-search">
      <span style={s.prefix} aria-hidden>
        ⌕
      </span>
      <input
        ref={inputRef}
        type="text"
        data-testid="library-search-input"
        placeholder={effectivePlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Esc clears the query when there's text, otherwise just blurs.
            if (value.length > 0) {
              e.stopPropagation();
              onChange('');
            } else {
              inputRef.current?.blur();
            }
          }
        }}
        style={s.input}
        aria-label={t('library.search.aria')}
      />
      {value.length > 0 ? (
        <button
          type="button"
          data-testid="library-search-clear"
          style={s.clearBtn}
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
          aria-label={t('library.search.clear')}
        >
          ×
        </button>
      ) : (
        !focused && <span style={s.hint} aria-hidden>/</span>
      )}
    </div>
  );
});

export default SearchBar;
