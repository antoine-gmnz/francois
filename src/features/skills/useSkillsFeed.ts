import { useEffect, useMemo, useState } from 'react';
import type { AppError, SkillInfo } from '../../../contract/common';
import { onSkillsEvent, skillsList } from '../../lib/api';
import { setPaletteSkills } from '../palette/paletteData';

export interface SkillsFeed {
  skills: SkillInfo[];
  status: 'loading' | 'loaded' | 'error';
  listError: AppError | null;
  refetch: (sid: string, mountedRef?: { current: boolean }) => void;
}

/** Skill list for one session: hydrate + live skills.changed subscription, also
 *  feeding the palette's run-skill secondary step (FR-19). */
export function useSkillsFeed(sessionId: string | null): SkillsFeed {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [listError, setListError] = useState<AppError | null>(null);

  const refetch = useMemo(
    () => (sid: string, mountedRef?: { current: boolean }) => {
      setStatus('loading');
      void skillsList(sid).then((res) => {
        if (mountedRef && !mountedRef.current) return;
        if (res.ok) {
          setSkills(res.data);
          setPaletteSkills(sid, res.data); // feed the palette's run-skill secondary step (FR-19)
          setStatus('loaded');
          setListError(null);
        } else {
          setListError(res.error);
          setStatus('error');
        }
      });
    },
    [],
  );

  useEffect(() => {
    setSkills([]);
    if (!sessionId) {
      setStatus('loaded');
      return;
    }
    const mounted = { current: true };
    let unlisten: (() => void) | undefined;
    refetch(sessionId, mounted);
    void onSkillsEvent((e) => {
      if (e.type === 'skills.changed' && e.sessionId === sessionId) refetch(sessionId, mounted);
    }).then((unsub) => {
      if (!mounted.current) unsub();
      else unlisten = unsub;
    });
    return () => {
      mounted.current = false;
      if (unlisten) unlisten();
    };
  }, [sessionId, refetch]);

  return { skills, status, listError, refetch };
}
