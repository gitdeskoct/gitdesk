import { describe, expect, it } from 'vitest';
import { pageList } from '../components/ui/pager';
import { qualityOf } from './network';

describe('qualityOf', () => {
  it('labels the system estimate in four steps plus offline', () => {
    expect(qualityOf(false, 50, 20).label).toBe('Offline');
    expect(qualityOf(true, 50, 20).label).toBe('Excellent');
    expect(qualityOf(true, 150, 5).label).toBe('Good');
    expect(qualityOf(true, 600, 1).label).toBe('Fair');
    expect(qualityOf(true, 2000, 0.2).label).toBe('Weak');
  });

  it('copes with a browser that gives no estimate', () => {
    expect(qualityOf(true, null, null)).toMatchObject({ level: 4, rtt: null });
  });
});

describe('pageList', () => {
  it('shows every page up to five, then collapses with gaps', () => {
    expect(pageList(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageList(1, 9)).toEqual([1, 2, null, 9]);
    expect(pageList(5, 9)).toEqual([1, null, 4, 5, 6, null, 9]);
    expect(pageList(9, 9)).toEqual([1, null, 8, 9]);
  });
});
