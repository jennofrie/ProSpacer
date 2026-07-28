// Get a page from "just loaded" to "running the game", and stay there.
//
// The dev server hot-reloads on any source edit, which throws away the JS
// context and puts the title card back up. A capture that started before the
// reload finishes happily and screenshots the title screen — every assertion
// still passes, and the only clue is that the picture is wrong. So: click
// through the DOM rather than through Playwright's actionability checks (the
// overlay animates its opacity and a click landing mid-transition is silently
// discarded), then verify the overlay is actually gone, and start over if it
// is not.
export async function bootGame(page, { setup = null, settle = 0, after = null, tries = 4 } = {}) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    let out, reason = 'game never came up';
    try {
      /* Already running? Then there is no overlay to wait for.
         The wait below is for the boot overlay to become *visible*, which only
         happens once — so calling this a second time on a live page waits the
         full timeout and deadlocks. Anything that wants several shots from one
         browser has to be able to call it per shot. */
      const alreadyLive = await page.evaluate(() => !!(window.__game && window.__game.started)
        && document.getElementById('boot').style.display === 'none').catch(() => false);
      if (alreadyLive) {
        if (setup) out = await page.evaluate(`(()=>{ const g = window.__game; return (${setup}); })()`);
        if (settle) await page.waitForTimeout(settle);
        const still = await page.evaluate(() => !!(window.__game && window.__game.started)
          && document.getElementById('boot').style.display === 'none').catch(() => false);
        if (still) {
          if (after) out = await page.evaluate(`(()=>{ const g = window.__game; return (${after}); })()`);
          return out;
        }
        // fell through: the page reloaded under us, so boot it properly below
      }
      await page.waitForFunction(
        () => { const b = document.getElementById('bootStart'); return b && !b.hidden; },
        { timeout: 90000 });
      await page.evaluate(() => document.getElementById('bootStart').click());
            // Generous on purpose: boot bakes cubemaps, warms shaders and now loads
      // model assets, and a slow cold start is not a failure.
      await page.waitForFunction(() => window.__game && window.__game.started, { timeout: 120000 });
      await page.waitForTimeout(1500);
      if (setup) out = await page.evaluate(`(()=>{ const g = window.__game; return (${setup}); })()`);
      if (settle) await page.waitForTimeout(settle);
      const live = await page.evaluate(() =>
        !!(window.__game && window.__game.started)
        && document.getElementById('boot').style.display === 'none');
      // The post-settle read has to be inside the retry, not after it. A reload
      // during a long settle leaves the game booted but back at spawn — not
      // landed, not posed — so an expression written against the set-up state
      // throws on a null, which reads as a code bug rather than as churn.
      if (live && after) out = await page.evaluate(`(()=>{ const g = window.__game; return (${after}); })()`);
      if (live) return out;
      reason = 'overlay came back after settle';
    } catch (e) {
      /* Both a reload and a broken expression land here, and reporting every
         failure as a reload is worse than saying nothing: it sends the reader
         hunting for a hot reload that never happened while the real fault is a
         typo in their own setup string. That cost time once already — a bad
         `bodyRef` printed "reload detected mid-capture" four times and looked
         exactly like the dev server churning.

         So ask the page. If the game is still up, the expression threw on its
         own account, and retrying it three more times will only produce the
         same exception with the true one buried above it. Fail immediately and
         hand back the real error. */
      const stillLive = await page.evaluate(() => !!(window.__game && window.__game.started)
        && document.getElementById('boot').style.display === 'none').catch(() => false);
      if (stillLive) throw e;
      if (attempt === tries) throw e;
      reason = `page went away (${String(e.message || e).split('\n')[0]})`;
    }
    if (attempt < tries) console.log(`[boot] ${reason}, retry ${attempt + 1}/${tries}`);
  }
  throw new Error('game never stayed booted — is something rewriting src/ during the run?');
}
