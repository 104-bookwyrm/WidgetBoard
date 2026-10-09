// Collection: a thumbnail grid for displaying goods, figures, merchandise, cards.
// Each item has an image and an optional label. Click to view full-size.
// Drag-and-drop images or use the + button. Reorder by dragging within the grid.
// Frameless mode for transparent desktop display.
import { esc } from '../util.js';

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
    .coll-grid { flex: 1; display: grid; gap: 4px; overflow-y: auto; overflow-x: hidden;
      grid-template-columns: repeat(var(--cols, 3), 1fr);
      align-content: start; min-height: 0; }
    .coll-item { position: relative; aspect-ratio: 1; border-radius: calc(var(--radius) * .4);
      overflow: hidden; cursor: pointer; background: color-mix(in srgb, var(--c3) 8%, transparent); }
    .coll-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .coll-item .coll-lbl { position: absolute; left: 0; right: 0; bottom: 0;
      padding: 1px 4px; font-size: .68em; line-height: 1.3;
      background: rgb(0 0 0 / .55); color: #fff; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; text-align: center; }
    .coll-item .coll-del { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px;
      border-radius: 50%; background: rgb(0 0 0 / .5); color: #fff; font-size: 11px;
      display: none; place-items: center; cursor: pointer; line-height: 18px; text-align: center; }
    .coll-item:hover .coll-del { display: grid; }

    .coll-empty { flex: 1; display: grid; place-items: center; text-align: center;
      opacity: .55; font-size: .85em; cursor: pointer; }
    .coll-empty small { display: block; margin-top: 2px; opacity: .8; }

    .coll-count { flex: none; text-align: center; font-size: .72em; opacity: .5;
      padding-top: 3px; }

    .coll-drop { position: absolute; inset: 0; background: color-mix(in srgb, var(--c2) 12%, var(--c1));
      display: grid; place-items: center; font-size: .9em; font-weight: 600;
      border: 2px dashed var(--c2); border-radius: var(--radius); z-index: 10; pointer-events: none; }

    /* lightbox overlay */
    .coll-lb { position: absolute; inset: 0; z-index: 20; background: rgb(0 0 0 / .82);
      display: grid; place-items: center; cursor: zoom-out; }
    .coll-lb img { max-width: 95%; max-height: 92%; object-fit: contain; border-radius: 4px; }
    .coll-lb .coll-lb-label { position: absolute; bottom: 8px; left: 0; right: 0;
      text-align: center; color: #fff; font-size: .85em; opacity: .9; }

    /* edit label input */
    .coll-edit { position: absolute; left: 0; right: 0; bottom: 0; z-index: 5;
      padding: 2px 4px; font-size: .72em; border: none; outline: 1px solid var(--c2);
      background: var(--c1); color: var(--c3); text-align: center; }
  `,
    mount(root, s, api) {
        const { t } = api;
        const bad = new Set();
        let dragCount = 0;

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

        // -- drag & drop from outside --
        root.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        root.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragCount === 1) showDrop(true); });
        root.addEventListener('dragleave', () => { if (--dragCount <= 0) { dragCount = 0; showDrop(false); } });
        root.addEventListener('drop', (e) => { e.preventDefault(); dragCount = 0; showDrop(false); addFiles(e.dataTransfer.files); });

        function showDrop(on) {
            let el = root.querySelector('.coll-drop');
            if (on && !el) {
                el = document.createElement('div');
                el.className = 'coll-drop';
                el.textContent = t('cl.drop');
                root.appendChild(el);
            } else if (!on && el) el.remove();
        }

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
                box.innerHTML = `<div class="coll-empty">🖼 ${t('cl.empty')}<small>${t('cl.hint')}</small></div>`;
                box.querySelector('.coll-empty').addEventListener('click', chooser);
                return;
            }

            const cols = autoCols();
            box.innerHTML = `
        <div class="coll-grid" style="--cols:${cols}">
          ${s.items.map((it, i) => `
            <div class="coll-item" data-i="${i}">
              <img src="${esc(api.assetUrl(it.img))}" alt="${esc(it.label)}" loading="lazy">
              ${it.label ? `<span class="coll-lbl">${esc(it.label)}</span>` : ''}
              <div class="coll-del" data-del="${i}">×</div>
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
                s.items.splice(+del.dataset.del, 1);
                api.save(); build(); return;
            }

            // close lightbox
            if (e.target.closest('.coll-lb')) {
                root.querySelector('.coll-lb')?.remove();
                return;
            }

            // open lightbox
            const item = e.target.closest('.coll-item');
            if (item) {
                const it = s.items[+item.dataset.i];
                if (!it) return;
                const lb = document.createElement('div');
                lb.className = 'coll-lb';
                lb.innerHTML = `<img src="${esc(api.assetUrl(it.img))}" alt="">
          ${it.label ? `<div class="coll-lb-label">${esc(it.label)}</div>` : ''}`;
                root.appendChild(lb);
                return;
            }
        });

        // double-click to edit label
        box.addEventListener('dblclick', (e) => {
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

            const finish = () => {
                it.label = input.value.trim();
                api.save();
                input.remove();
                build();
            };
            input.addEventListener('blur', finish);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') finish();
                if (ev.key === 'Escape') { input.remove(); build(); }
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
            destroy: () => { },
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