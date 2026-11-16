// Tools → Files: the file browser (file-browser.js) as a page.
Router.register('files', async (content) => {
  const fb = await FileBrowser.mount(content, { page: true });
  return () => fb.destroy();
});
