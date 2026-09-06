import { Calendar, Truck, ChevronRight } from 'lucide-react';
import { formatTripScheduleDate, formatPhDate } from '../../utils/datetime';
import { formatMoney } from '../../utils/currencyInput';

/**
 * Public-facing presentation of a trip, styled for the About page's bento
 * card language rather than the customer app's list-card chrome. The data
 * shape and the capacity math below mirror the customer Trips page exactly
 * (`pages/customer/TripsPage.jsx`) — only the markup/classNames differ.
 */
const TripScheduleCard = ({ trip, onSelect }) => {
  const departure = formatTripScheduleDate(trip.departure_date);
  const spaceLeftKg = Math.max(0, (trip.capacity || 0) - (trip.current_weight || 0));
  const ratePerKg = formatMoney(parseFloat(trip.price_per_kg || 70));

  return (
    <button
      type="button"
      className="about-bento-card about-trip-card"
      onClick={() => onSelect(trip)}
      aria-label={`View or book the ${trip.origin} to ${trip.destination} trip departing ${departure.full}`}
    >
      <div className="about-trip-card-top">
        <div className="about-trip-date-badge">
          <span>{departure.month}</span>
          <strong>{departure.day}</strong>
        </div>
        <div className="about-trip-card-route">
          <div className="about-trip-card-route-title">{trip.origin} <ChevronRight size={16} aria-hidden="true" /> {trip.destination}</div>
          <div className="about-trip-card-meta">
            <Truck size={14} aria-hidden="true" />
            <span>{trip.trip_number}</span>
          </div>
        </div>
      </div>

      <div className="about-trip-card-details">
        <div className="about-trip-card-detail-row">
          <Calendar size={14} aria-hidden="true" />
          <span>Departs {departure.full}</span>
        </div>
        {trip.arrival_date && (
          <div className="about-trip-card-detail-row">
            <Calendar size={14} aria-hidden="true" />
            <span>Estimated arrival {formatPhDate(trip.arrival_date)}</span>
          </div>
        )}
      </div>

      <div className="about-trip-card-badges">
        <span className="badge badge-info about-trip-card-badge">
          <strong>{spaceLeftKg.toLocaleString()} kg</strong>&nbsp;space left
        </span>
        <span className="badge badge-success about-trip-card-badge">
          <strong>{ratePerKg}/kg</strong>&nbsp;rate
        </span>
      </div>
    </button>
  );
};

export default TripScheduleCard;
