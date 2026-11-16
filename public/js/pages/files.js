// Tools → Files: the file browser (file-browser.js) as a page.
Router.register('files', async (content) => {
  const navId = Router._navId;
  // #content stays in the page across navigations: a slow load must not draw over the next page.
  const fb = await FileBrowser.mount(content, { page: true, alive: () => Router.isActiveNav(navId) });
  return () => fb.destroy();
});
