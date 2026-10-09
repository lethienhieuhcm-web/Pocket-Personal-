// js/features/billing.js — plan info and limit UI helpers
import { apiCall } from '../core/api.js';
import { toast } from '../core/dom.js';
import { t } from '../core/i18n.js';

export async function getPlan(){
  try{
    const j = await apiCall('/api/user/plan');
    return {plan: j.plan || 'free', expires_at: j.expires || null, days_left: j.days_left || 0};
  }catch(e){
    return {plan: 'free'};
  }
}

export function showLimitToast(){
  toast(t('limitReached') || 'Limit reached. Please upgrade to continue.');
}
