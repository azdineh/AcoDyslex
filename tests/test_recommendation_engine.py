import unittest
from recommendation.engine import recommend

def obs(typ='omission', count=2, opportunities=3, distinct_items=2,
        verification_status='human_verified', meaning_changed=False):
    return {'error_type':typ, 'target':'ظ…ظژط¯ظ’ط±ظژط³ظژط©','count':count,
            'opportunities':opportunities, 'distinct_items':distinct_items,
            'verification_status':verification_status, 'meaning_changed':meaning_changed}

class EngineTests(unittest.TestCase):
    def test_verified_repeated_error_recommends(self):
        result = recommend({'child_id':'anonymous','observations':[obs()]})
        self.assertEqual(result['status'],'recommendations_proposed')
        self.assertEqual(result['individualized_recommendations'][0]['error_type'],'omission')
        self.assertEqual(len(result['individualized_recommendations'][0]['exercises']),2)
    def test_asr_only_never_recommends(self):
        result = recommend({'observations':[obs(count=6, opportunities=6,
                                               distinct_items=4,
                                               verification_status='automated_unverified')]})
        self.assertFalse(result['individualized_recommendations'])
        self.assertTrue(result['needs_verification'])
    def test_one_item_not_sufficient(self):
        result = recommend({'observations':[obs(count=3, distinct_items=1)]})
        self.assertFalse(result['individualized_recommendations'])
    def test_single_error_not_sufficient(self):
        result = recommend({'observations':[obs(count=1, opportunities=3)]})
        self.assertFalse(result['individualized_recommendations'])
    def test_vowel_length_low_priority(self):
        result = recommend({'observations':[obs('long_vowel_confusion',2,3,2,meaning_changed=False)]})
        self.assertFalse(result['individualized_recommendations'])
    def test_vowel_length_meaningful(self):
        result = recommend({'observations':[obs('long_vowel_confusion',2,3,2,meaning_changed=True)]})
        self.assertEqual(len(result['individualized_recommendations']),1)
    def test_invalid_denominator(self):
        result = recommend({'observations':[obs(count=7, opportunities=3)]})
        self.assertFalse(result['individualized_recommendations'])
    def test_malformed_counter_requires_review_without_crashing(self):
        result = recommend({'observations':[obs(count='not-a-count')]})
        self.assertFalse(result['individualized_recommendations'])
        self.assertIn('Compteurs invalides', result['needs_verification'][0]['reason'])
    def test_rank_two_domains(self):
        s={'mastery':{'inversion':0.2,'omission':0.3,'consonant_substitution':0.5},'observations':[
          obs('inversion',3,4,2),obs('omission',2,4,2),obs('consonant_substitution',3,4,2)]}
        result=recommend(s)
        self.assertEqual(len(result['individualized_recommendations']),2)
    def test_unknown_error(self):
        result=recommend({'observations':[obs('made_up')]})
        self.assertEqual(result['status'],'verification_required')

if __name__=='__main__': unittest.main()

