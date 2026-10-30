import { describe, it, expect } from 'vitest';
import { jobCountsAsSale, jobCountsAsSaleWhere } from '../jobSale';

describe('does this job count as a sale for its Sold By', () => {
  it('counts a job that did not come from a service plan visit', () => {
    expect(jobCountsAsSale({ source_plan_id: null })).toBe(true);
  });

  it('does not count a job booked from a service plan visit', () => {
    expect(jobCountsAsSale({ source_plan_id: 'plan-1' })).toBe(false);
  });
});
