import { getToolCallString } from '@codebuff/common/tools/utils'

import type { ToolDescription } from '../tool-def-type'

const toolName = 'browser_logs'
export const browserLogsTool = {
  toolName,
  description: `
Purpose: Use this tool to check the output of console.log or errors in order to debug issues, test functionality, or verify expected behavior.

IMPORTANT: Assume the user's development server is ALREADY running and active, unless you see logs indicating otherwise. Never start the user's development server for them, unless they ask you to do so.
Never offer to interact with the website aside from reading them (see available actions below). The user will manipulate the website themselves and bring you to the UI they want you to interact with.

### Response Analysis

After each action, you'll receive:
1. Success/failure status
2. New console logs since last action
3. Network requests and responses
4. JavaScript errors with stack traces

Use this data to:
- Verify expected behavior
- Debug issues
- Guide next actions
- Make informed decisions about fixes

### Best Practices

**Workflow**
- Navigate to the user's website, probably on localhost, but you can compare with the production site if you want.
- Scroll to the relevant section
- Take screenshots and analyze confirm changes
- Check network requests for anomalies

**Debugging Flow**
- Start with minimal reproduction steps
- Collect data at each step
- Analyze results before next action
- Take screenshots to track your changes after each UI change you make

There is currently only one type of browser action available:
Navigate:
   - Load a new URL in the current browser window and get the logs after page load.
   Params:
   - \`type\`: (required) Must be equal to 'navigate'
   - \`url\`: (required) The URL to navigate to.
   - \`waitUntil\`: (required) One of 'load', 'domcontentloaded', 'networkidle0'

Example:
${getToolCallString(toolName, {
  type: 'navigate',
  url: 'localhost:3000',
  waitUntil: 'domcontentloaded',
})}
    `.trim(),
} satisfies ToolDescription
