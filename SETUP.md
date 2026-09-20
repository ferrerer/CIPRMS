# CIPRMS — Velzon Template Integration

## What changed

All EJS view files have been re-wrapped to use the **Velzon** admin template
shell (sidebar, topbar, Bootstrap layout) while keeping every page's existing
content, modals, and JavaScript intact.

---

## File structure delivered

```
views/
  partials/
    header.ejs             ← Velzon topbar (replaces old top-header)
    sidebar.ejs            ← Velzon sidebar — Admin role
    sidebar_personnel.ejs  ← Velzon sidebar — Personnel role
    sidebar_viewonly.ejs   ← Velzon sidebar — View-only role
  admin_dashboard.ejs
  viewonly_dashboard.ejs
  registry.ejs / personnel_registry.ejs
  requests.ejs / personnel_requests.ejs
  calendar.ejs
  lifecycle.ejs
  reports.ejs / personnel_reports.ejs
  users.ejs
  notifications.ejs
  admin_access_requests.ejs
  admin_settings.ejs / personnel_settings.ejs
  viewonly_access_request.ejs
  login.ejs / signup.ejs / index.ejs  ← unchanged (standalone auth pages)

public/
  ciprms-bridge.css   ← bridges your existing content CSS classes to Velzon
```

---

## Setup steps

### 1. Add Velzon assets to your Express static path

Unzip the Velzon template's `assets/` folder and serve it at `/velzon/assets/`:

```javascript
// cirl.js / app.js
app.use('/velzon/assets', express.static(path.join(__dirname, 'velzon/assets')));
```

So your project should have:
```
velzon/
  assets/
    css/
      app.min.css
      bootstrap.min.css
      icons.min.css
      custom.min.css
    js/
      layout.js
      app.js
      plugins.js
      pages/plugins/lord-icon-2.1.0.js
    libs/
      bootstrap/js/bootstrap.bundle.min.js
      simplebar/simplebar.min.js
      node-waves/waves.min.js
      feather-icons/feather.min.js
      ...
```

### 2. Copy `ciprms-bridge.css` to your `public/` folder

```bash
cp public/ciprms-bridge.css /your-project/public/velzon/assets/css/ciprms-bridge.css
```

Or serve it from `/public/` and update the link in the page templates.

### 3. Replace your `views/` directory

Drop all files from this `views/` folder into your project's `views/` directory,
replacing the old ones.

---

## Active page highlighting

Each page's sidebar link highlights automatically.
Pass `activePage` from your route:

```javascript
res.render('admin_dashboard', { activePage: 'dashboard' });
res.render('registry',        { activePage: 'registry' });
res.render('calendar',        { activePage: 'calendar' });
// etc.
```

Available keys: `dashboard`, `calendar`, `lifecycle`, `registry`, `requests`,
`reports`, `users`, `access-requests`, `notifications`, `settings`, `request-access`

---

## Theme customisation

The `<html>` tag on every page has Velzon data attributes you can change:

| Attribute         | Options                        | Default    |
|-------------------|--------------------------------|------------|
| `data-sidebar`    | `dark`, `light`, `gradient`    | `dark`     |
| `data-topbar`     | `light`, `dark`                | `light`    |
| `data-sidebar-size` | `lg`, `sm`, `sm-hover`       | `lg`       |
| `data-theme-colors` | `default`, `teal`, `cyan`, `purple`, `green`, `pink` | `default` |

---

## Automatic partnership map location (optional configuration)

When Administrator/Staff add or edit a partnership, the server works out its
map location from the **partner institution + country** using OpenStreetMap
**Nominatim** — no API key is needed. Every setting below is optional:

| Environment variable   | Purpose | Default |
|------------------------|---------|---------|
| `GEOCODER_PROVIDER`    | `nominatim`, or `none` to turn institution-level lookup off (country-level fallback only) | `nominatim` (`none` under `NODE_ENV=test`) |
| `GEOCODER_USER_AGENT`  | Identifying User-Agent sent to Nominatim (its usage policy requires one — add a contact URL/email of your own) | `CIPRMS-CSPC-CIRL/1.0 (...)` |
| `GEOCODER_BASE_URL`    | Point at a self-hosted or compatible Nominatim instance | `https://nominatim.openstreetmap.org` |

The public service allows at most 1 request/second (enforced in
`services/geocodingService.js`) and requires results to be cached (stored in
the `geocodecache` collection). Lookups happen when a form field is committed,
never per keystroke.
