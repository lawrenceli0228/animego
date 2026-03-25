import { SEASONS, STATUS_OPTIONS, getCurrentSeason, GENRES } from '../utils/constants'

describe('constants', () => {
  describe('SEASONS', () => {
    it('contains all four seasons', () => {
      expect(SEASONS).toEqual(['WINTER', 'SPRING', 'SUMMER', 'FALL'])
    })
  })

  describe('STATUS_OPTIONS', () => {
    it('has four statuses with required fields', () => {
      expect(STATUS_OPTIONS).toHaveLength(4)
      STATUS_OPTIONS.forEach(opt => {
        expect(opt).toHaveProperty('value')
        expect(opt).toHaveProperty('label')
        expect(opt).toHaveProperty('color')
      })
    })

    it('includes watching, completed, plan_to_watch, dropped', () => {
      const values = STATUS_OPTIONS.map(o => o.value)
      expect(values).toContain('watching')
      expect(values).toContain('completed')
      expect(values).toContain('plan_to_watch')
      expect(values).toContain('dropped')
    })
  })

  describe('getCurrentSeason()', () => {
    it('returns one of the four valid seasons', () => {
      const result = getCurrentSeason()
      expect(SEASONS).toContain(result)
    })

    it('returns WINTER for January (month 1)', () => {
      vi.setSystemTime(new Date('2025-01-15'))
      expect(getCurrentSeason()).toBe('WINTER')
      vi.useRealTimers()
    })

    it('returns SPRING for April (month 4)', () => {
      vi.setSystemTime(new Date('2025-04-15'))
      expect(getCurrentSeason()).toBe('SPRING')
      vi.useRealTimers()
    })

    it('returns SUMMER for July (month 7)', () => {
      vi.setSystemTime(new Date('2025-07-15'))
      expect(getCurrentSeason()).toBe('SUMMER')
      vi.useRealTimers()
    })

    it('returns FALL for October (month 10)', () => {
      vi.setSystemTime(new Date('2025-10-15'))
      expect(getCurrentSeason()).toBe('FALL')
      vi.useRealTimers()
    })
  })

  describe('GENRES', () => {
    it('contains Action and Romance', () => {
      expect(GENRES).toContain('Action')
      expect(GENRES).toContain('Romance')
    })
  })
})
