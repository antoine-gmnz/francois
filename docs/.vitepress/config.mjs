import { defineConfig } from 'vitepress'

// Deployed to GitHub Pages at https://antoine-gmnz.github.io/francois/
// by .github/workflows/docs.yml — `base` must match the repo name.
export default defineConfig({
  title: 'Francois',
  description:
    'Mission control for your Claude Code fleet — a native desktop app (Tauri 2, Rust core, React frontend) that spawns and supervises multiple Claude Code sessions in one window.',
  base: '/francois/',
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/png', href: '/francois/favicon-32.png' }]],

  themeConfig: {
    logo: '/francois-mark.png',

    nav: [
      { text: 'Guide', link: '/guide/what-is-francois' },
      { text: 'Reference', link: '/reference/keyboard-shortcuts' },
      {
        text: 'Releases',
        link: 'https://github.com/antoine-gmnz/francois/releases',
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Francois?', link: '/guide/what-is-francois' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Interface tour', link: '/guide/interface-tour' },
          ],
        },
        {
          text: 'Working with sessions',
          items: [
            { text: 'Sessions & projects', link: '/guide/sessions-and-projects' },
            { text: 'Conversation & permissions', link: '/guide/conversation-and-permissions' },
            { text: 'Diff & shell', link: '/guide/diff-and-shell' },
            { text: 'Notifications & sound', link: '/guide/notifications' },
          ],
        },
        {
          text: 'Agents & tools',
          items: [
            { text: 'Agents, MCP & skills', link: '/guide/agents-mcp-skills' },
            { text: 'Command palette', link: '/guide/command-palette' },
            { text: 'Extensions', link: '/guide/extensions' },
          ],
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Accounts & usage', link: '/guide/accounts' },
            { text: 'Worktree isolation', link: '/guide/worktree-isolation' },
            { text: 'Remote control', link: '/guide/remote-control' },
            { text: 'Overview dashboard', link: '/guide/overview-dashboard' },
          ],
        },
        {
          text: 'Under the hood',
          items: [{ text: 'Architecture', link: '/guide/architecture' }],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Keyboard shortcuts', link: '/reference/keyboard-shortcuts' },
            { text: 'The francois CLI', link: '/reference/cli' },
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'Troubleshooting', link: '/reference/troubleshooting' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/antoine-gmnz/francois' }],

    search: { provider: 'local' },

    outline: { level: [2, 3] },

    footer: {
      message: 'Released under the AGPL-3.0 license.',
      copyright: '© 2026 Antoine Gimenez',
    },

    editLink: {
      pattern: 'https://github.com/antoine-gmnz/francois/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
