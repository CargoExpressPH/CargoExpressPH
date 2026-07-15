import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const springPhysics = {
  type: 'spring',
  stiffness: 260,
  damping: 30,
  mass: 0.9,
};

const exitTransition = {
  duration: 0.12,
  ease: 'easeOut',
};

const pageVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: springPhysics,
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: exitTransition,
  },
};

const reducedPageVariants = {
  hidden: { opacity: 1 },
  visible: { opacity: 1 },
  exit: { opacity: 1 },
};

const PageTransition = ({ children, className = '', delay = 0, as = 'div', style = {}, ...rest }) => {
  const MotionComponent = motion[as] || motion.div;
  const shouldReduceMotion = useReducedMotion();

  return (
    <MotionComponent
      className={`w-full ${className}`}
      variants={shouldReduceMotion ? reducedPageVariants : pageVariants}
      initial={shouldReduceMotion ? false : 'hidden'}
      animate="visible"
      exit="exit"
      style={style}
      transition={!shouldReduceMotion && delay ? { ...springPhysics, delay: delay / 1000 } : undefined}
      {...rest}
    >
      {children}
    </MotionComponent>
  );
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
};

const reducedItemVariants = {
  hidden: { opacity: 1 },
  visible: { opacity: 1 },
};

export const StaggerItem = ({ children, index, delay, className = '', style = {}, layout = false, ...rest }) => {
  const shouldReduceMotion = useReducedMotion();
  let calculatedDelay = 0;
  if (delay !== undefined) {
    calculatedDelay = delay / 1000;
  } else if (index !== undefined) {
    calculatedDelay = index * 0.05;
  }

  const customTransition = calculatedDelay > 0
    ? { ...springPhysics, delay: calculatedDelay }
    : springPhysics;

  return (
    <motion.div
      className={className}
      variants={shouldReduceMotion ? reducedItemVariants : itemVariants}
      initial={shouldReduceMotion ? false : 'hidden'}
      animate="visible"
      transition={shouldReduceMotion ? undefined : customTransition}
      style={style}
      layout={!shouldReduceMotion && layout}
      {...rest}
    >
      {children}
    </motion.div>
  );
};

export const SharedElement = ({ children, layoutId, className = '', style = {}, ...rest }) => {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.div
      className={className}
      layoutId={layoutId}
      layout={!shouldReduceMotion}
      transition={springPhysics}
      style={style}
      {...rest}
    >
      {children}
    </motion.div>
  );
};

export default PageTransition;
