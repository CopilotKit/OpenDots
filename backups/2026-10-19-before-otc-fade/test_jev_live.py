"""Opt-in local model + isolated browser check. Never uses a user's open tab."""
import asyncio
import os
import unittest
from jev import check_image, select_target


@unittest.skipUnless(os.environ.get('JEV_LIVE_TEST') == '1', 'Requires running local JEV model')
class LiveJevTest(unittest.IsolatedAsyncioTestCase):
    async def test_menu_selection_and_visual_checks(self):
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            chrome = await pw.chromium.launch(channel='chrome', headless=True)
            try:
                page = await chrome.new_page(viewport={'width': 800, 'height': 500})
                await page.set_content('<style>body{font:32px Arial;background:white;color:black}button{font:28px Arial;padding:20px;margin:20px}</style><h1>Account settings</h1><button>Open menu</button><button>Help</button><p>Menu is closed</p>')
                shot = await page.screenshot()
                selected = await asyncio.to_thread(select_target, 'Open menu button', [
                    {'ref': 1, 'name': 'Open menu', 'role': 'button', 'inView': True},
                    {'ref': 2, 'name': 'Help', 'role': 'button', 'inView': True},
                ], shot)
                self.assertEqual(selected['ref'], 1)
                yes = await asyncio.to_thread(check_image, 'A button labelled Open menu is visible.', shot)
                no = await asyncio.to_thread(check_image, 'A button labelled Delete account is visible.', shot)
                print({'selected': selected, 'positive': yes, 'negative': no}, flush=True)
                self.assertEqual(yes['assessment'], 'yes')
                self.assertEqual(no['assessment'], 'no')
            finally:
                await chrome.close()
