/** Page fragments with fake layout (see fakeEnv.ts). Each captures the elements listed in `targets`. */
export interface Fixture {
  name: string;
  html: string;
  targets: string[];
  images?: Record<string, string | null>;
  textRects?: Record<string, string>;
}

export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const FIXTURES: Fixture[] = [
  {
    name: 'flex row',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 200 50" style="display: flex; flex-direction: row; gap: 8px; padding: 4px; align-items: center; background-color: rgb(250, 250, 250)">
      <div id="a" data-rect="4 4 50 42" style="background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="62 4 50 42" style="background-color: rgb(0, 0, 255); border-radius: 6px"></div>
    </div>`,
  },
  {
    name: 'grid',
    targets: ['t'],
    html: `<div id="t" data-rect="10 20 300 100" style="display: grid; background-color: rgb(255, 255, 255)">
      <div id="a" data-rect="10 20 100 50" style="background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="150 20 100 50" style="background-color: rgb(0, 255, 0)"></div>
    </div>`,
  },
  {
    name: 'margins',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 200" style="display: flex; border: 2px solid rgb(0, 0, 0)">
      <div id="a" data-rect="22 12 100 50" style="margin: 10px 0 0 20px; background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="122 2 100 50" style="background-color: rgb(0, 255, 0)"></div>
    </div>`,
  },
  {
    name: 'text',
    targets: ['t'],
    html: `<p id="t" data-rect="0 0 200.4 40" style="color: rgb(17, 17, 17); font-size: 14px; font-family: &quot;Inter Display&quot;, system-ui, sans-serif; line-height: 20px; text-align: center">Hello   <b>bold</b> and <em style="color: rgb(255, 0, 0)">red</em><br>next</p>`,
  },
  {
    name: 'mixed content',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 100" style="background-color: rgb(240, 240, 240); padding: 10px; color: rgb(50, 50, 50)">
      Loose text <span>run</span>
      <div id="c" data-rect="10 40 280 50" style="border-radius: 4px; background-color: rgb(255, 255, 255)">Inner</div>
      <button id="btn" data-rect="10 40 80 30" style="background-color: rgb(37, 99, 235); color: rgb(255, 255, 255); padding: 4px 12px">Go</button>
    </div>`,
  },
  {
    name: 'pseudo',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 100 40" style="position: relative; background-color: rgb(255, 255, 255)"
      data-before="content: &quot;★&quot;; position: absolute; left: 4px; top: 6px; width: 10px; height: 12px; color: rgb(255, 0, 0)"
      data-after="content: &quot;&quot;; position: absolute; left: 0px; top: 38px; width: 100px; height: 2px; background-color: rgb(0, 0, 0)">
      <span id="s" data-rect="20 10 60 20">Starred</span>
    </div>`,
  },
  {
    name: 'hidden',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 200 100">
      <div data-rect="0 0 50 50" style="display: none">gone-display</div>
      <div data-rect="0 0 50 50" style="visibility: hidden">gone-visibility</div>
      <div data-rect="0 0 0 0" style="overflow: hidden">gone-zero</div>
      <div id="v" data-rect="0 50 50 50">shown</div>
      <script>bad()</script>
    </div>`,
  },
  {
    name: 'images',
    targets: ['t'],
    images: { 'https://cdn.test/ok.png': PNG, 'https://cdn.test/bg.png': PNG },
    html: `<div id="t" data-rect="0 0 400 100" style="background-image: linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255)), url(&quot;https://cdn.test/bg.png&quot;); background-size: auto, cover">
      <img id="bad" src="https://cdn.test/missing.png" data-rect="0 0 120 80" style="border-radius: 8px">
      <img id="good" src="https://cdn.test/ok.png" data-rect="140 0 120 80" style="object-fit: cover">
    </div>`,
  },
  {
    name: 'svg',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 40 40" style="color: rgb(255, 0, 0)">
      <svg id="icon" data-rect="8 8 24 24" viewBox="0 0 24 24" width="24" height="24"><path d="M0 0L24 24" fill="currentColor" stroke="currentColor"></path><circle class="dot" cx="12" cy="12" r="4" style="fill: rgb(0, 128, 0)"></circle></svg>
    </div>`,
  },
  {
    name: 'form',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 120">
      <input id="email" placeholder="Email" data-rect="0 0 200 32" style="border: 1px solid rgb(200, 200, 200); padding: 4px 8px; font-size: 14px">
      <input id="name" value="Ada" data-rect="0 40 200 32" style="border: 1px solid rgb(200, 200, 200)">
      <iframe id="frame" src="https://video.example.com/embed/1" data-rect="0 80 200 40"></iframe>
    </div>`,
  },
  {
    name: 'icon then text',
    targets: ['t'],
    textRects: { Download: '20 4 70 16' },
    html: `<a id="t" data-rect="0 0 120 24" style="display: inline-block; color: rgb(0, 0, 238)"><svg data-rect="0 4 16 16" viewBox="0 0 16 16" width="16" height="16"><path d="M0 0h16v16H0z" fill="currentColor"></path></svg> Download</a>`,
  },
  {
    name: 'hidden flex child',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 40" style="display: flex; gap: 8px">
      <div id="a" data-rect="0 0 50 40" style="background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="58 0 50 40" style="visibility: hidden; background-color: rgb(0, 255, 0)"></div>
      <div id="c" data-rect="116 0 50 40" style="background-color: rgb(0, 0, 255)"></div>
    </div>`,
  },
  {
    name: 'zero-size flex child',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 40" style="display: flex; gap: 8px">
      <div id="a" data-rect="0 0 50 40" style="background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="58 0 0 40" style="overflow: hidden"></div>
      <div id="c" data-rect="66 0 50 40" style="background-color: rgb(0, 0, 255)"></div>
    </div>`,
  },
  {
    name: 'two targets',
    targets: ['a', 'b'],
    html: `<div id="a" data-rect="0 0 100 50" style="background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="500 300 120 60" style="background-color: rgb(0, 0, 255)"></div>`,
  },
];

export const fixture = (name: string): Fixture => FIXTURES.find((f) => f.name === name)!;

/** Pages the exact serializer must reproduce structurally (margins, grid, tables, inline flow). */
export const EXACT_FIXTURES: Fixture[] = [
  {
    name: 'grid template',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 316 100" style="display: grid; grid-template-columns: 100px 200px; gap: 8px 16px; background-color: rgb(255, 255, 255)">
      <div id="a" data-rect="0 0 100 50" style="background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="116 0 200 50" style="background-color: rgb(0, 255, 0); grid-column-start: 2"></div>
    </div>`,
  },
  {
    name: 'child margins',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 200" style="display: flex; padding: 8px">
      <div id="a" data-rect="8 20 100 50" style="margin-top: 12px; background-color: rgb(255, 0, 0)"></div>
      <div id="b" data-rect="108 8 100 50" style="margin: 0px 0px 0px 4px; background-color: rgb(0, 255, 0)"></div>
    </div>`,
  },
  {
    name: 'inline text',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 20">Hello <b>bold</b> <span class="badge" data-rect="80 0 20 20" style="background-color: rgb(221, 244, 255); padding: 0px 6px; border-radius: 10px">3</span> world</div>`,
  },
  {
    name: 'inherited',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 200 60" style="color: rgb(10, 20, 30); font-size: 14px">
      <div id="same" data-rect="0 0 200 20" style="color: rgb(10, 20, 30)">same</div>
      <div id="diff" data-rect="0 20 200 20" style="color: rgb(200, 0, 0)">diff</div>
    </div>`,
  },
  {
    name: 'table',
    targets: ['t'],
    html: `<table id="t" data-rect="0 0 200 40" style="border-collapse: collapse"><tbody data-rect="0 0 200 40"><tr data-rect="0 0 200 40">
      <td data-rect="0 0 100 40" style="padding: 4px"><div data-rect="4 4 92 32">A</div></td>
      <td data-rect="100 0 100 40" style="padding: 4px">B</td>
    </tr></tbody></table>`,
  },
  {
    name: 'pseudo children',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 100 40" style="position: relative"
      data-before="content: &quot;★&quot;; color: rgb(255, 0, 0)"
      data-after="content: &quot;&quot;; display: block; position: absolute; left: 0px; top: 38px; width: 100px; height: 2px; background-color: rgb(0, 0, 0)">
      <div id="s" data-rect="0 10 100 20">Starred</div>
    </div>`,
  },
  {
    name: 'file name',
    targets: ['t'],
    html: `<table data-rect="0 0 300 20" style="background-color: rgb(246, 248, 250)"><tbody><tr><td id="t" data-rect="0 0 300 20" style="padding: 0px 16px">
      <div class="react-directory-filename-column" data-rect="16 0 268 20" style="display: flex; align-items: center; column-gap: 10px">
        <div class="overflow-hidden" data-rect="16 0 268 20" style="overflow: hidden">
          <div class="react-directory-filename-cell" data-rect="16 0 268 20">
            <div class="react-directory-truncate" data-rect="16 0 120 20" style="display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; vertical-align: top">
              <a class="Link--primary" href="/x/README.md" style="color: rgb(31, 35, 40)">README.md</a>
            </div>
          </div>
        </div>
      </div>
    </td></tr></tbody></table>`,
  },
  {
    name: 'fixed and sticky',
    targets: ['t'],
    html: `<div id="t" data-rect="0 0 300 100" style="position: relative">
      <div id="f" data-rect="0 0 300 20" style="position: fixed; top: 0px; left: 0px; width: 300px; height: 20px; background-color: rgb(1, 2, 3)"></div>
      <div id="st" data-rect="0 20 300 20" style="position: sticky; top: 64px; height: 20px; background-color: rgb(4, 5, 6)"></div>
    </div>`,
  },
];

export const exactFixture = (name: string): Fixture => [...EXACT_FIXTURES, ...FIXTURES].find((f) => f.name === name)!;
