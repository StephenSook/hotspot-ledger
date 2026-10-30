import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFileSync } from 'node:fs'

const PAGES = [
  { hash: '#/ledger', heading: /keeps coming back/i },
  { hash: '#/next', heading: /no report yet/i },
  { hash: '#/plan', heading: /short list a person approves/i },
  { hash: '#/evidence', heading: /every number on this site/i },
]

for (const p of PAGES) {
  test(`${p.hash} renders real data and passes axe`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`/${p.hash}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.heading, { timeout: 30_000 })
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .exclude('canvas')
      .analyze()
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    expect(errors).toEqual([])
  })
}

test('ledger numbers come from the pipeline, not from the page', async ({ page, request }) => {
  const metrics = await (await request.get('/data/metrics.json')).json()
  await page.goto('/#/ledger')
  await expect(page.getByText(metrics.dumping_reports.toLocaleString('en-US'), { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(String(metrics.hotspots))
})

test('hiding the most active account changes citywide numbers, never a per-spot view', async ({ page, request }) => {
  const metrics = await (await request.get('/data/metrics.json')).json()
  const first = Object.keys(metrics.yearly)[0]
  await page.goto('/#/ledger')
  const count = page.getByText(/\[\d+\] in total/)
  await expect(count).toBeVisible({ timeout: 30_000 })
  const before = await count.textContent()
  await expect(page.getByTestId(`year-${first}`)).toContainText(metrics.yearly[first].toLocaleString('en-US'))
  await page.getByRole('button', { name: /hide the most active account/i }).click()
  await expect(page.getByRole('button', { name: /show every account/i })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId(`year-${first}`)).toContainText(metrics.yearly_without_top_account[first].toLocaleString('en-US'))
  await expect(page.getByText(/would map one person's reports/i)).toBeVisible()
  await expect(count).toHaveText(before ?? '')
})

test('plan: approval stays locked until the owner of the ground is confirmed', async ({ page }) => {
  await page.goto('/#/plan')
  await expect(page.getByText(/0 approved \/ \d+/)).toBeVisible({ timeout: 45_000 })
  const approve = page.getByRole('button', { name: 'Approve', exact: true }).first()
  await expect(approve).toBeDisabled()
  await page.getByLabel(/who owns the ground/i).first().selectOption('city')
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect(page.getByText(/1 approved/)).toBeVisible()
})

test('published data carries no identifying fields', async ({ request }) => {
  for (const name of ['cells.json', 'metrics.json', 'risk.json', 'model.json']) {
    const text = await (await request.get(`/data/${name}`)).text()
    for (const bad of ['"reporter', '"description"', '"summary"', '"address"', 'seeclickfix.com/rails']) {
      expect(text, `${bad} in ${name}`).not.toContain(bad)
    }
  }
})

const SAMPLE = readFileSync(new URL('./sample-notice-token.txt', import.meta.url), 'utf8').trim()

test('a signed notice link verifies in the browser and passes axe', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/#/v/${SAMPLE}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The signature is valid.', { timeout: 30_000 })
  await expect(page.getByText(/Plus Code 865QRCC9\+32/).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /Report dumping/ })).toHaveAttribute('href', /mableton\.gov/)
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
  expect(errors).toEqual([])
})

test('an edited notice link is refused', async ({ page }) => {
  const [body, sig] = SAMPLE.split('.')
  const flipped = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21)
  await page.goto(`/#/v/${flipped}.${sig}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not a verified notice.', { timeout: 30_000 })
})

test('the print view carries a QR code that opens the verify link', async ({ page }) => {
  await page.goto(`/#/print/${SAMPLE}`)
  const qr = page.getByRole('img', { name: /QR code/ })
  await expect(qr).toBeVisible({ timeout: 30_000 })
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
})

test('plan: rejecting a proposal withdraws its draft and its sign button', async ({ page }) => {
  // The API is stubbed here so the test runs without server secrets; the real functions have their own suite.
  await page.route('**/api/draft', (r) => r.fulfill({ json: { en: 'Draft EN', es: 'Borrador ES', sentences: ['where', 'action', 'how_to_report'], model: 'stub', drafted_at: '2026-10-30T00:00:00Z', status: 'draft' } }))
  await page.goto('/#/plan')
  await expect(page.getByText(/0 approved \/ \d+/)).toBeVisible({ timeout: 45_000 })
  await page.getByLabel(/who owns the ground/i).first().selectOption('city')
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
  await page.getByRole('button', { name: /Draft notice/ }).first().click()
  const sign = page.getByRole('button', { name: 'Approve text and sign' })
  await expect(sign).toBeVisible()
  await page.getByRole('button', { name: 'Reject', exact: true }).first().click()
  await expect(sign).toHaveCount(0)
  await expect(page.getByText('Draft EN')).toHaveCount(0)
})

test('plan: a new draft during a pending signature drops the old signature', async ({ page }) => {
  // Stubbed API: the second draft answers at once while the first signature is still in flight.
  let drafts = 0
  await page.route('**/api/draft', (r) => {
    drafts += 1
    const t = drafts === 1 ? 'Draft A' : 'Draft B'
    return r.fulfill({ json: { en: t, es: t, sentences: ['where', 'action', 'how_to_report'], model: 'stub', drafted_at: '2026-10-30T00:00:00Z', status: 'draft' } })
  })
  await page.route('**/api/sign', async (r) => {
    await new Promise((done) => setTimeout(done, 2500))
    await r.fulfill({ json: { token: SAMPLE, path: `/#/v/${SAMPLE}`, en: 'Draft A', es: 'Draft A', sentences: ['where'], signed_at: '2026-10-30T00:00:00Z' } })
  })
  await page.goto('/#/plan')
  await expect(page.getByText(/0 approved \/ \d+/)).toBeVisible({ timeout: 45_000 })
  await page.getByLabel(/who owns the ground/i).first().selectOption('city')
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
  await page.getByRole('button', { name: /Draft notice/ }).first().click()
  await expect(page.getByText('Draft A').first()).toBeVisible()
  const signAnswered = page.waitForResponse('**/api/sign')
  await page.getByRole('button', { name: 'Approve text and sign' }).click()
  await page.getByRole('button', { name: /Draft notice/ }).first().click()
  await expect(page.getByText('Draft B').first()).toBeVisible()
  // Check only after the old signature's answer has landed and had time to render. The counts are read
  // once (no retry), because a retrying "count is 0" passes on its first look, before a late answer renders.
  await signAnswered
  await page.waitForTimeout(2000)
  expect(await page.getByRole('link', { name: 'Print signed notice' }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Approve text and sign' }).count()).toBe(1)
})
