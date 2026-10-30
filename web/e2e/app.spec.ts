import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

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

test('hiding the most active account changes the spot list', async ({ page }) => {
  await page.goto('/#/ledger')
  const count = page.getByText(/\[\d+\] in total/)
  await expect(count).toBeVisible({ timeout: 30_000 })
  const before = await count.textContent()
  await page.getByRole('button', { name: /hide the most active account/i }).click()
  await expect(count).not.toHaveText(before ?? '')
})

test('plan: approval stays locked until the owner of the ground is confirmed', async ({ page }) => {
  await page.goto('/#/plan')
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
