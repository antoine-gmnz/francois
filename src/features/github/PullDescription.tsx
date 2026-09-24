// github-ci-logs refinement — the PR description card at the top of the pull
// detail's left column. Rendered with the conversation's markdown renderer
// (precedent: QuestionCard imports InlineMarkdown from there). Long bodies
// cap at 240px behind a Show more / Show less toggle rather than scrolling
// inside the card. The renderer's links never navigate the webview; a click
// is routed to `github_open_url` instead (repo-host URLs only).

import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import Markdown from '../conversation/MarkdownView';
import { Button } from '../../ui/Button';
import { openOnGithub } from './actions';
import { CollapsibleCard } from './CollapsibleCard';
import { pullDescription } from './pulls';
import './pulls.css';

/** Keep in sync with `.pull-desc__body--clamped` max-height in pulls.css. */
const CLAMP_PX = 240;

export function PullDescription({ cwd, body }: { cwd: string; body: string }): JSX.Element {
  const text = pullDescription(body);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    setOverflows(el !== null && el.scrollHeight > CLAMP_PX + 1);
  }, [text]);

  function onLinkClick(e: MouseEvent<HTMLDivElement>): void {
    const link = (e.target as HTMLElement).closest('a');
    const href = link?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(href)) void openOnGithub(cwd, href);
  }

  return (
    <CollapsibleCard id="description" className="pull-desc" head={<span className="pull-card__title">Description</span>}>
      {text === null ? (
        <p className="pull-desc__empty">No description provided.</p>
      ) : (
        <>
          <div
            ref={bodyRef}
            className={overflows && !expanded ? 'pull-desc__body pull-desc__body--clamped' : 'pull-desc__body'}
            onClick={onLinkClick}
          >
            <Markdown text={text} />
          </div>
          {overflows && (
            <div className="pull-desc__foot">
              <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Show less' : 'Show more'}
              </Button>
            </div>
          )}
        </>
      )}
    </CollapsibleCard>
  );
}
