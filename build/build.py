"""Builds the self-hosted app (web/index.html) from the shared app page.

The shared page keeps all budget logic. This script swaps in:
  - the Supabase storage layer (sign-in, live sync)
  - sign-in screen, household invites, bank connection, notifications
  - starting balances, home-screen (PWA) support
Run: python3 build/build.py <path-to-shared-index.html>
"""
import sys, pathlib

src = pathlib.Path(sys.argv[1]).read_text()
root = pathlib.Path(__file__).resolve().parent.parent

def rep(a, b):
    global src
    assert a in src, "missing: " + a[:100]
    src = src.replace(a, b, 1)

def cut(start_marker, end_marker, new):
    global src
    i = src.index(start_marker); j = src.index(end_marker, i)
    src = src[:i] + new + src[j:]

# ---------- <head>: PWA bits + config ----------
rep('<link href="https://fonts.googleapis.com/css2?family=Inter',
    '''<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#2563eb">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Budget">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<script src="config.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter''')
rep('<title>Envelope Budget</title>', '<title>Budget</title>')

# ---------- storage layer ----------
cut("const Store = {", "/* ===================== data layer", (root / "build" / "store.js").read_text() + "\n\n")

# ---------- boot: sign-in when there's no session ----------
rep("""  if (!info) { $('#app').innerHTML = `<div class="card empty">Sign in to open this budget. If you're signed in and still see this, ask the person who set it up to share it with you as a Contributor.</div>`; return; }""",
    """  if (!info) { showSignIn(); return; }
  if (info.error) { $('#app').innerHTML = `<div class="card empty">Couldn't open your budget: ${esc(info.error)}<br><br><button class="btn" onclick="location.reload()">Try again</button></div>`; return; }""")

# ---------- Household screen: replace claude.ai sharing text ----------
rep("""  <h2>Sharing with your household</h2><div class="card note">Open this page's <b>Share</b> menu and add each person as a <b>Contributor</b>. They open it on their phone, come to this screen, and tap <b>This is me</b> on their card.<br><br>Tip: in the phone's browser, “Add to Home Screen” makes it open like an app.</div>
  <h2>Coming later</h2><div class="card note">When this budget moves to its own server, it will link to your bank, send a notification to whoever's card was used, and match autopay bills automatically. Until then, add purchases with <b>+</b> or import your bank's CSV file from Activity.</div>""",
    """  ${viewServerCards()}""")
rep("""  <h2>Start over</h2>""", """  <h2>Starting balances</h2><div class="card"><p class="note" style="margin-top:0">What was in each bucket on day one. Change these any time; nothing at the bank changes.</p><button class="btn full" id="s_start">Set starting balances…</button></div>
  <h2>Start over</h2>""")
rep("""  return h;
}

/* ===================== bindings""", """  h += `<button class="btn full" id="s_signout" style="margin-top:22px">Sign out of this phone</button>`;
  return h;
}

/* ===================== bindings""")

# ---------- starting balances banner on Buckets ----------
rep("""  if (demoCount()) h += `<button class="demo-pill\"""",
    """  if (cats.length && cfg().startDone !== true && !live(S.moves).length) h += `<button class="banner" style="margin-top:10px" id="startBanner"><span class="bicon">🏁</span><span class="grow"><b>Set your starting balances</b><br><span class="small muted">What's in each bucket today</span></span>›</button>`;
  if (demoCount()) h += `<button class="demo-pill\"""")

# ---------- extra bindings + server features ----------
rep("  const sr = $('#s_reset'); if (sr)", "  bindServer();\n  const sr = $('#s_reset'); if (sr)")
rep("\nboot();\n</script>", "\n" + (root / "build" / "server-ui.js").read_text() + "\nboot();\n</script>")

out = root / "web" / "index.html"
out.write_text(src)
print("wrote", out, len(src), "bytes")
