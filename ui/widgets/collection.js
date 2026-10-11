// Collection: a thumbnail grid for displaying goods, figures, merchandise, cards.
// Each item has an image and an optional label. Click to view full-size.
// Drag-and-drop images or use the + button. Drag a thumbnail (or Alt+arrows) to reorder.
// Frameless mode for transparent desktop display.
import { esc, dropZone } from '../util.js';
import { icon } from '../icons.js';

export default {
    size: { w: 2, h: 3 },
    min: { w: 1, h: 2 },
    defaults: {
        items: [],      // [{img:'hash.png', label:''}, ...]
        columns: 0,     // 0 = auto
        frameless: false,
    },
    css: `
    .coll { position: absolute; inset: 0; display: flex; flex-direction: column;
      box-sizing: border-box; padding: calc(var(--head-h) - 2px) var(--pad) var(--pad);
      overflow: hidden; }
    .coll-grid { flex: 1; display: grid; gap: var(--space-2); overflow-y: auto; overflow-x: hidden;
      grid-template-columns: repeat(var(--cols, 3), 1fr);
      align-content: start; min-height: 0; }
    .coll-item { position: relative; aspect-ratio: 1; border-radius: var(--r-inner);
      overflow: hidden; cursor: pointer; background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .coll-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .coll-item .coll-lbl { position: absolute; left: 0; right: 0; bottom: 0;
      padding: 1px 4px; font-size: var(--fs-meta); line-height: 1.3;
      background: rgb(0 0 0 / .55); color: #fff; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; text-align: center; }
    .coll-item .coll-del { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px;
      min-width: 0; padding: 0; border: none; border-radius: 50%;
      background: rgb(0 0 0 / .5); color: #fff; font-size: 11px; line-height: 18px;
      cursor: pointer; opacity: 0; }
    .coll-item:hover .coll-del, .coll-item:focus-within .coll-del { opacity: 1; }
    /* reorder: the dragged item fades, a ghost follows the pointer, an accent edge marks the drop spot */
    .coll-item.dragging { opacity: .3; }
    .coll-item.drop-before { box-shadow: inset 3px 0 0 var(--c2); }
    .coll-item.drop-after { box-shadow: inset -3px 0 0 var(--c2); }
    .coll-ghost { position: fixed; z-index: 1000; pointer-events: none; aspect-ratio: 1; overflow: hidden;
      border-radius: var(--r-inner); box-shadow: 0 6px 22px rgb(0 0 0 / .45); opacity: .9; }
    .coll-ghost img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .coll-ghost .coll-del { display: none; }

    .coll-empty { flex: 1; display: grid; place-items: center; text-align: center; color: var(--text-faint); font-size: var(--fs-small); cursor: pointer; }
    .coll-empty small { display: block; margin-top: 2px; }

    .coll-count { flex: none; text-align: center; font-size: var(--fs-meta); color: var(--text-faint);
      padding-top: 3px; }

    /* lightbox overlay */
    .coll-lb { position: absolute; inset: 0; z-index: 20; background: rgb(0 0 0 / .82);
      display: grid; place-items: center; cursor: zoom-out; }
    .coll-lb img { max-width: 95%; max-height: 92%; object-fit: contain; border-radius: var(--r-inner); }
    .coll-lb .coll-lb-label { position: absolute; bottom: 8px; left: 0; right: 0;
      text-align: center; color: #fff; font-size: var(--fs-small); opacity: .9; }

    /* edit label input */
    .coll-edit { position: absolute; left: 0; right: 0; bottom: 0; z-index: 5;
      padding: 2px 4px; font-size: var(--fs-meta); border: none; outline: 1px solid var(--c2);
      background: var(--c1); color: var(--c3); text-align: center; }
  `,
    mount(root, s, api) {
        const { t } = api;
        const bad = new Set();

        root.innerHTML = `<div class="coll"></div>`;
        const box = root.firstElementChild;

        // -- file handling --
        const isImg = (f) => f.type && f.type.startsWith('image/');

        async function addFiles(files) {
            const imgs = [...files].filter(isImg);
            if (!imgs.length) return files.length && api.toast(t('toast.not_image'));
            for (const f of imgs) {
                try {
                    const name = await api.uploadImage(f);
                    if (!s.items.some((it) => it.img === name))
                        s.items.push({ img: name, label: '' });
                    bad.delete(name);
                } catch { }
            }
            api.save();
            build();
        }

        const chooser = async () => addFiles(await api.pickImages());

        dropZone(root, t('w.drop'), addFiles);

        // -- compute columns --
        function autoCols() {
            if (s.columns > 0) return s.columns;
            const w = api.size.w;
            if (w <= 1) return 2;
            if (w <= 2) return 3;
            if (w <= 3) return 4;
            return Math.min(6, w + 1);
        }

        // -- build --
        function build() {
            if (!s.items.length) {
                box.innerHTML = `<div class="coll-empty"><div>${icon('image')} ${t('cl.empty')}<small>${t('cl.hint')}</small></div></div>`;
                box.querySelector('.coll-empty').addEventListener('click', chooser);
                return;
            }

            const cols = autoCols();
            box.innerHTML = `
        <div class="coll-grid" style="--cols:${cols}">
          ${s.items.map((it, i) => `
            <div class="coll-item" data-i="${i}" tabindex="0" aria-label="${esc(it.label || t('cl.item', { n: i + 1 }))}">
              <img src="${esc(api.assetUrl(it.img))}" alt="${esc(it.label)}" loading="lazy" draggable="false">
              ${it.label ? `<span class="coll-lbl">${esc(it.label)}</span>` : ''}
              <button class="coll-del" data-del="${i}" aria-label="${esc(t('cl.delete', { name: it.label || i + 1 }))}">${icon('x')}</button>
            </div>`).join('')}
        </div>
        <div class="coll-count">${s.items.length} ${t('cl.items')}</div>`;

            // mark broken images
            box.querySelectorAll('.coll-item img').forEach((img) => {
                img.onerror = () => { bad.add(s.items[+img.closest('[data-i]').dataset.i]?.img); img.style.opacity = '.3'; };
            });
        }

        // -- events --
        box.addEventListener('click', (e) => {
            // delete
            const del = e.target.closest('[data-del]');
            if (del) {
                const i = +del.dataset.del;
                const [gone] = s.items.splice(i, 1);
                api.save(); build();
                api.deleted(() => { s.items.splice(Math.min(i, s.items.length), 0, gone); api.save(); build(); });
                return;
            }

            // open lightbox (a click that ends a drag doesn't count)
            const item = e.target.closest('.coll-item');
            // wait out a possible double-click (label edit) before opening
            if (item && !justDragged && e.detail < 2) {
                clearTimeout(lbTimer);
                lbTimer = setTimeout(() => openLightbox(+item.dataset.i), 250);
            }
        });

        let lbTimer = 0;
        function openLightbox(i) {
            const it = s.items[i];
            if (!it) return;
            const lb = document.createElement('div');
            lb.className = 'coll-lb';
            lb.tabIndex = -1; // focusable so Esc reaches the keydown handler below
            lb.innerHTML = `<img src="${esc(api.assetUrl(it.img))}" alt="">
          ${it.label ? `<div class="coll-lb-label">${esc(it.label)}</div>` : ''}`;
            root.appendChild(lb);
            lb.focus();
        }

        function moveItem(from, to) {
            const [it] = s.items.splice(from, 1);
            s.items.splice(to, 0, it);
            api.save();
            build();
        }

        // -- reorder by dragging (pointer events, so it never meets the file-drop overlay) --
        let justDragged = false;
        let endDrag = null; // set while a drag runs; destroy() calls it
        box.addEventListener('pointerdown', (e) => {
            const cell = e.target.closest('.coll-item');
            if (!cell || e.button !== 0 || e.target.closest('.coll-del, input')) return;
            const from = +cell.dataset.i;
            const sx = e.clientX, sy = e.clientY;
            const grid = box.querySelector('.coll-grid');
            let ghost = null, marked = null, to = null;
            cell.setPointerCapture(e.pointerId);
            const unmark = () => { marked?.classList.remove('drop-before', 'drop-after'); marked = null; };
            const move = (ev) => {
                if (!ghost) {
                    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
                    api.setInteracting(true);
                    const r = cell.getBoundingClientRect();
                    ghost = cell.cloneNode(true);
                    ghost.classList.add('coll-ghost'); // keeps .coll-item styling (label strip)
                    ghost.style.width = r.width + 'px';
                    ghost._dx = sx - r.left;
                    ghost._dy = sy - r.top;
                    document.body.append(ghost);
                    cell.classList.add('dragging');
                }
                ghost.style.left = ev.clientX - ghost._dx + 'px';
                ghost.style.top = ev.clientY - ghost._dy + 'px';
                const gr = grid.getBoundingClientRect();
                if (ev.clientY < gr.top + 24) grid.scrollTop -= 10;
                else if (ev.clientY > gr.bottom - 24) grid.scrollTop += 10;
                unmark();
                const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.coll-item');
                to = null;
                if (!over || !grid.contains(over) || over === cell) return;
                const r = over.getBoundingClientRect();
                const after = ev.clientX > r.left + r.width / 2;
                const i = +over.dataset.i;
                // index in the list once the dragged item is taken out
                to = (after ? i + 1 : i) - (i > from || (after && i === from) ? 1 : 0);
                over.classList.add(after ? 'drop-after' : 'drop-before');
                marked = over;
            };
            // release is watched on the window: a re-render (upload done, resize) can replace `cell`
            const up = () => {
                endDrag = null;
                cell.removeEventListener('pointermove', move);
                cell.removeEventListener('lostpointercapture', up);
                removeEventListener('pointerup', up);
                removeEventListener('pointercancel', up);
                unmark();
                if (!ghost) return;
                ghost.remove();
                cell.classList.remove('dragging');
                api.setInteracting(false);
                justDragged = true;
                setTimeout(() => (justDragged = false));
                if (to !== null && to !== from && cell.isConnected) moveItem(from, to);
            };
            endDrag = up;
            cell.addEventListener('pointermove', move);
            cell.addEventListener('lostpointercapture', up);
            addEventListener('pointerup', up);
            addEventListener('pointercancel', up);
        });

        // keyboard: Enter opens, Alt+←/→ moves one place, Alt+↑/↓ one row
        box.addEventListener('keydown', (e) => {
            const cell = e.target.closest('.coll-item');
            if (!cell || e.target !== cell) return;
            const i = +cell.dataset.i;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return openLightbox(i); }
            const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -autoCols(), ArrowDown: autoCols() }[e.key];
            if (!e.altKey || !step) return;
            e.preventDefault();
            const j = Math.max(0, Math.min(s.items.length - 1, i + step));
            if (j === i) return;
            moveItem(i, j);
            box.querySelector(`.coll-item[data-i="${j}"]`)?.focus();
            api.announce?.(t('cl.moved', { n: j + 1, total: s.items.length }));
        });

        // close lightbox: it lives on root (outside box), so box's click handler never sees it
        root.addEventListener('click', (e) => {
            if (e.target.closest('.coll-lb')) root.querySelector('.coll-lb')?.remove();
        });

        // double-click to edit label
        box.addEventListener('dblclick', (e) => {
            clearTimeout(lbTimer);
            const item = e.target.closest('.coll-item');
            if (!item || e.target.closest('.coll-del')) return;
            const idx = +item.dataset.i;
            const it = s.items[idx];
            if (!it) return;

            // remove existing edit inputs
            box.querySelectorAll('.coll-edit').forEach((el) => el.remove());

            const input = document.createElement('input');
            input.className = 'coll-edit';
            input.value = it.label;
            input.placeholder = t('cl.label_hint');
            item.appendChild(input);
            input.focus();
            input.select();

            // once only: removing the input fires blur, which would run this again mid-removal
            let done = false;
            const finish = (keep) => {
                if (done) return;
                done = true;
                if (keep) { it.label = input.value.trim(); api.save(); }
                input.remove();
                build();
            };
            input.addEventListener('blur', () => finish(true));
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') finish(true);
                if (ev.key === 'Escape') finish(false);
            });
        });

        // close lightbox on Escape
        root.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') root.querySelector('.coll-lb')?.remove();
        });

        // frameless
        if (s.frameless) api.setFrameless(true);

        build();

        return {
            destroy: () => { clearTimeout(lbTimer); endDrag?.(); },
            resized: () => build(),
            menu: () => [
                { text: t('cl.add'), action: chooser },
                { item: 'Separator' },
                {
                    text: (s.frameless ? '✓ ' : '') + t('cl.frameless'),
                    action: () => {
                        s.frameless = !s.frameless; api.setFrameless(s.frameless); api.save();
                    },
                },
            ],
            summary: () =>
                s.items.length
                    ? t('sum.collection', { n: s.items.length })
                    : t('sum.cl_empty'),
        };
    },
};