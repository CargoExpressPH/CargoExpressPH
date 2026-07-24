import {
  ShieldCheck, Clock, Truck, Package, MapPin, Phone, Star,
  Zap, Heart, Award, ThumbsUp, CheckCircle2, Globe, Headphones,
  Warehouse, Navigation, BadgeCheck, Handshake, BarChart3, Lock,
  Leaf, RefreshCw, Users, Target, TrendingUp, Box, Send
} from 'lucide-react';

const FEATURE_ICONS = {
  ShieldCheck, Clock, Truck, Package, MapPin, Phone, Star,
  Zap, Heart, Award, ThumbsUp, CheckCircle2, Globe, Headphones,
  Warehouse, Navigation, BadgeCheck, Handshake, BarChart3, Lock,
  Leaf, RefreshCw, Users, Target, TrendingUp, Box, Send
};

export function getFeatureIcon(iconName) {
  return FEATURE_ICONS[iconName] || Star;
}
